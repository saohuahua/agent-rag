import { Injectable, Logger } from '@nestjs/common'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { EmbeddingModel, LanguageModel } from 'ai'
import { PrismaService } from '../prisma/prisma.service'

/** 一个供应商的可调用模型工厂 */
export interface ProviderBundle {
  chatModel(modelId: string): LanguageModel
  embeddingModel(modelId: string): EmbeddingModel
}

/** 缓存条目：DB 行 + SDK provider 实例 */
interface CacheEntry {
  row: { id: number; name: string; baseUrl: string; apiKeyEnv: string }
  bundle: ProviderBundle | null // null = key 未配置 该供应商不可用
}

/**
 * 供应商注册表：DB 的 model_providers 行 → AI SDK provider 实例（内存缓存 30s）
 * 统一用 createOpenAICompatible：DeepSeek 官方即 OpenAI 兼容协议 少一条分支少一类不确定
 * （规格原写 @ai-sdk/deepseek 优先 实测统一 openai-compatible 更稳 已在报告记录偏差）
 * 密钥从 env 动态读取（DB 存的是变量名 此处是 EnvService 之外的合理例外 注释备案）
 */
@Injectable()
export class ProviderRegistry {
  private readonly logger = new Logger(ProviderRegistry.name)

  /** 缓存（30s TTL admin 改配置后最多 30s 生效 演示场景足够） */
  private cache: CacheEntry[] = []

  private cacheAt = 0

  static readonly CACHE_TTL_MS = 30_000

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 取供应商的模型工厂
   * @param providerId DB 主键
   * @returns null 表示该供应商不可用（禁用或 key 未配置）
   */
  async getBundle(providerId: number): Promise<ProviderBundle | null> {
    const entries = await this.load()
    const hit = entries.find(e => e.row.id === providerId)
    return hit?.bundle ?? null
  }

  /** 供应商名 → 工厂（测试与诊断用） */
  async getBundleByName(name: string): Promise<ProviderBundle | null> {
    const entries = await this.load()
    return entries.find(e => e.row.name === name)?.bundle ?? null
  }

  /** 强制失效缓存（admin 改配置后调用） */
  invalidate(): void {
    this.cacheAt = 0
  }

  /** 加载（带 TTL） */
  private async load(): Promise<CacheEntry[]> {
    if (this.cache.length > 0 && Date.now() - this.cacheAt < ProviderRegistry.CACHE_TTL_MS) {
      return this.cache
    }

    const rows = await this.prisma.modelProvider.findMany({ where: { enabled: true } })

    this.cache = rows.map(row => {
      const apiKey = process.env[row.apiKeyEnv] ?? ''
      if (!apiKey) {
        this.logger.warn(`provider ${row.name} 的 ${row.apiKeyEnv} 未配置 跳过`)
        return { row, bundle: null }
      }

      const p = createOpenAICompatible({
        name: row.name,
        baseURL: row.baseUrl,
        apiKey,
        includeUsage: true, // 流式 usage 挂在末块 计量依赖它
      })
      return {
        row,
        bundle: {
          chatModel: (id: string) => p.chatModel(id),
          embeddingModel: (id: string) => p.textEmbeddingModel(id),
        },
      }
    })
    this.cacheAt = Date.now()
    return this.cache
  }
}
