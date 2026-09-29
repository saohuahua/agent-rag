import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { EnvService } from './config/env.service'

/**
 * 应用入口
 * enableShutdownHooks 必须开 否则 PrismaService 的 onModuleDestroy 不触发
 * CORS 放行 web 开发端口（3000）
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const env = app.get(EnvService)

  app.enableShutdownHooks()
  app.enableCors({ origin: ['http://localhost:3000'], credentials: true })

  await app.listen(env.API_PORT)
  console.log(`[api] ready at http://127.0.0.1:${env.API_PORT}/healthz`)
}

bootstrap()
