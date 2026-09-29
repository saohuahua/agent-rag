"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillTypes = exports.ChatTurnRequestSchema = void 0;
const zod_1 = require("zod");
// ===== gateway 区（任务 A 在此追加） =====
// ===== rag 区（任务 B 在此追加） =====
// ===== runtime 区（任务 C 在此追加） =====
// ===== skills 区（任务 H 在此追加） =====
// ===== web 区（任务 E 在此追加） =====
// ===== 基础 DTO（任务 0） =====
/** 会话 turn 请求体 */
exports.ChatTurnRequestSchema = zod_1.z.object({
    sessionId: zod_1.z.number().int().positive(),
    message: zod_1.z.string().min(1).max(4000),
});
/** 技能类型常量（与 Prisma enum 对齐） */
exports.SkillTypes = ['BUILTIN_FUNCTION', 'HTTP_RPA', 'EXTERNAL_AGENT'];
//# sourceMappingURL=index.js.map