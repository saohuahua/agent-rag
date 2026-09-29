import { HttpException, HttpStatus } from '@nestjs/common'

/** 路由耗尽：alias 的全部跳位都失败（可降级错误） 语义 502 */
export class RouteExhaustedError extends HttpException {
  constructor(alias: string, lastError?: string) {
    super(
      { code: 'RouteExhausted', message: `all routes failed for alias=${alias}`, lastError },
      HttpStatus.BAD_GATEWAY,
    )
  }
}

/** 企业月度预算软熔断 语义 429 */
export class BudgetExceededError extends HttpException {
  constructor(enterpriseId: number, budget: string) {
    super(
      {
        code: 'BudgetExceeded',
        message: `monthly budget exceeded enterpriseId=${enterpriseId} budget=${budget}`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }
}

/** embedding 维度异常：上游返回维度与 bge-m3 的 1024 不符（首次调用断言） */
export class EmbeddingDimensionError extends HttpException {
  constructor(actual: number) {
    super(
      { code: 'EmbeddingDimension', message: `expect 1024 dims got ${actual}` },
      HttpStatus.BAD_GATEWAY,
    )
  }
}
