-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('LLM', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "SkillType" AS ENUM ('BUILTIN_FUNCTION', 'HTTP_RPA', 'EXTERNAL_AGENT');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KbMode" AS ENUM ('INJECT', 'TOOL', 'BOTH');

-- CreateEnum
CREATE TYPE "DocSourceType" AS ENUM ('UPLOAD', 'CRAWL', 'MANUAL');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('UPLOADED', 'QUEUED', 'PARSING', 'INDEXED', 'FAILED', 'OCR_NEEDED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "GrantScopeType" AS ENUM ('ENTERPRISE', 'DEPARTMENT', 'MEMBER');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('LLM', 'EMBEDDING', 'RPA', 'EXTERNAL_AGENT');

-- CreateTable
CREATE TABLE "model_providers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnv" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_routes" (
    "id" SERIAL NOT NULL,
    "alias" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "upstreamModel" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "priceInPerMTok" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "priceOutPerMTok" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "maxTokens" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SkillType" NOT NULL,
    "description" TEXT NOT NULL,
    "configJson" JSONB,
    "riskLevel" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_templates" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "avatar" TEXT,
    "status" "TemplateStatus" NOT NULL,
    "reviewNote" TEXT,
    "createdBy" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_skill_bindings" (
    "id" SERIAL NOT NULL,
    "templateId" INTEGER NOT NULL,
    "skillKey" TEXT NOT NULL,
    "configJson" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "template_skill_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_kb_bindings" (
    "id" SERIAL NOT NULL,
    "templateId" INTEGER NOT NULL,
    "datasetId" INTEGER NOT NULL,
    "kbMode" "KbMode" NOT NULL,

    CONSTRAINT "template_kb_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_datasets" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_docs" (
    "id" SERIAL NOT NULL,
    "datasetId" INTEGER NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" "DocSourceType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "DocStatus" NOT NULL,
    "parseError" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" SERIAL NOT NULL,
    "docId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "page" INTEGER,
    "headingPath" TEXT,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "embedding" vector,
    "tsv" tsvector,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_packages" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_versions" (
    "id" SERIAL NOT NULL,
    "packageId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateStatus" NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "package_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_items" (
    "id" SERIAL NOT NULL,
    "packageVersionId" INTEGER NOT NULL,
    "templateSlug" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,

    CONSTRAINT "package_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprises" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "monthlyBudgetCny" DECIMAL(10,2) NOT NULL DEFAULT 500,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enterprises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "MemberRole" NOT NULL,
    "departmentId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "departmentId" INTEGER,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "packageId" INTEGER NOT NULL,
    "lockedPackageVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silicon_employees" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "templateSlug" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatar" TEXT,
    "configJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "silicon_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_grants" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "scopeType" "GrantScopeType" NOT NULL,
    "scopeId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "grantedBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER NOT NULL,
    "currentParticipantId" INTEGER,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_participants" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "role" "MessageRole" NOT NULL,
    "employeeId" INTEGER,
    "epoch" INTEGER NOT NULL,
    "partsJson" JSONB NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_events" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "employeeId" INTEGER,
    "type" TEXT NOT NULL,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER,
    "sessionId" INTEGER,
    "kind" "UsageKind" NOT NULL,
    "routeAlias" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costCny" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "enterpriseId" INTEGER,
    "actorMemberId" INTEGER,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_name_key" ON "model_providers"("name");

-- CreateIndex
CREATE INDEX "model_routes_alias_priority_idx" ON "model_routes"("alias", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "skills_key_key" ON "skills"("key");

-- CreateIndex
CREATE INDEX "employee_templates_slug_status_idx" ON "employee_templates"("slug", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employee_templates_slug_version_key" ON "employee_templates"("slug", "version");

-- CreateIndex
CREATE INDEX "template_skill_bindings_templateId_idx" ON "template_skill_bindings"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "template_kb_bindings_templateId_datasetId_key" ON "template_kb_bindings"("templateId", "datasetId");

-- CreateIndex
CREATE INDEX "knowledge_datasets_enterpriseId_idx" ON "knowledge_datasets"("enterpriseId");

-- CreateIndex
CREATE INDEX "knowledge_docs_enterpriseId_idx" ON "knowledge_docs"("enterpriseId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_docs_datasetId_checksum_key" ON "knowledge_docs"("datasetId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_docId_seq_key" ON "knowledge_chunks"("docId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_packages_slug_key" ON "subscription_packages"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "package_versions_packageId_version_key" ON "package_versions"("packageId", "version");

-- CreateIndex
CREATE INDEX "package_items_packageVersionId_idx" ON "package_items"("packageVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "enterprises_slug_key" ON "enterprises"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "departments_enterpriseId_path_key" ON "departments"("enterpriseId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "members_enterpriseId_userId_key" ON "members"("enterpriseId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "invitations_enterpriseId_idx" ON "invitations"("enterpriseId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_enterpriseId_packageId_key" ON "subscriptions"("enterpriseId", "packageId");

-- CreateIndex
CREATE INDEX "silicon_employees_enterpriseId_idx" ON "silicon_employees"("enterpriseId");

-- CreateIndex
CREATE INDEX "employee_grants_employeeId_idx" ON "employee_grants"("employeeId");

-- CreateIndex
CREATE INDEX "conversation_sessions_enterpriseId_idx" ON "conversation_sessions"("enterpriseId");

-- CreateIndex
CREATE INDEX "session_participants_sessionId_idx" ON "session_participants"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "session_participants_sessionId_employeeId_key" ON "session_participants"("sessionId", "employeeId");

-- CreateIndex
CREATE INDEX "conversation_messages_sessionId_idx" ON "conversation_messages"("sessionId");

-- CreateIndex
CREATE INDEX "execution_events_sessionId_id_idx" ON "execution_events"("sessionId", "id");

-- CreateIndex
CREATE INDEX "usage_records_enterpriseId_createdAt_idx" ON "usage_records"("enterpriseId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_records_createdAt_idx" ON "usage_records"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_enterpriseId_createdAt_idx" ON "audit_logs"("enterpriseId", "createdAt");

-- AddForeignKey
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_skill_bindings" ADD CONSTRAINT "template_skill_bindings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "employee_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_kb_bindings" ADD CONSTRAINT "template_kb_bindings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "employee_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_datasets" ADD CONSTRAINT "knowledge_datasets_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "knowledge_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_docId_fkey" FOREIGN KEY ("docId") REFERENCES "knowledge_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "subscription_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_packageVersionId_fkey" FOREIGN KEY ("packageVersionId") REFERENCES "package_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "subscription_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silicon_employees" ADD CONSTRAINT "silicon_employees_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silicon_employees" ADD CONSTRAINT "silicon_employees_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_grants" ADD CONSTRAINT "employee_grants_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_grants" ADD CONSTRAINT "employee_grants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "silicon_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "silicon_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ========== 向量与全文检索（手写区 Prisma 表达不了的部分）==========

CREATE EXTENSION IF NOT EXISTS vector;

-- Prisma 的 Unsupported("vector") 无法表达维度 HNSW 要求列带维度（2026-09-29 踩坑实录）
-- 不先 ALTER 出维度 直接建索引会报 column does not have dimensions
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" TYPE vector(1024);

-- HNSW 索引（bge-m3 固定 1024 维 余弦距离）
CREATE INDEX "knowledge_chunks_embedding_hnsw"
  ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 词法列索引：应用层 jieba 分词后的空格串 → simple 配置 tsvector + GIN
CREATE INDEX "knowledge_chunks_tsv_gin" ON "knowledge_chunks" USING gin ("tsv");
