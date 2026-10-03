-- ─────────────────────────────────────────────────────────────
-- Anticipation of Uncertainty · 建表 + GRANT + RLS
-- 每条语句独立执行（云服务 db_exec_sql 单次只支持一条，mode=migrate）。
-- 硬性顺序：CREATE TABLE → GRANT → ENABLE RLS → CREATE POLICY
-- 漏 GRANT 的症状：42501 "row-level security"，看着像策略错了，其实是没授权。
-- ─────────────────────────────────────────────────────────────

-- ── 1. 建表 ──────────────────────────────────────────────────

-- 1.1 长期记忆
CREATE TABLE IF NOT EXISTS wm_memories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL DEFAULT auth.uid(),
  category text NOT NULL DEFAULT 'general',
  content text NOT NULL,
  weight integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1.2 预测档案
CREATE TABLE IF NOT EXISTS wm_predictions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL DEFAULT auth.uid(),
  question text NOT NULL,
  domain text NOT NULL DEFAULT 'general',
  horizon text,
  confidence numeric,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdict text NOT NULL DEFAULT 'pending',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  reviewed_at timestamptz,
  horizon_days integer,
  outcome text
);

-- 1.3 用户档案
CREATE TABLE IF NOT EXISTS wm_profile (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL DEFAULT auth.uid(),
  nickname text,
  focus text,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. GRANT（先授权，再开 RLS）──────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE wm_memories TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE wm_predictions TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE wm_profile TO authenticated, anon;

-- ── 3. 开启 RLS ─────────────────────────────────────────────

ALTER TABLE wm_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_profile ENABLE ROW LEVEL SECURITY;

-- ── 4. 策略（每表 增/查/改/删 各一条，全绑 owner_id = auth.uid()）──

-- wm_memories
CREATE POLICY wm_mem_read_own ON wm_memories FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY wm_mem_insert_own ON wm_memories FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY wm_mem_update_own ON wm_memories FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY wm_mem_delete_own ON wm_memories FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- wm_predictions
CREATE POLICY wm_pred_read_own ON wm_predictions FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY wm_pred_insert_own ON wm_predictions FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY wm_pred_update_own ON wm_predictions FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY wm_pred_delete_own ON wm_predictions FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- wm_profile
CREATE POLICY wm_prof_read_own ON wm_profile FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY wm_prof_insert_own ON wm_profile FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY wm_prof_update_own ON wm_profile FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY wm_prof_delete_own ON wm_profile FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- ── 5. 验证 ─────────────────────────────────────────────────
-- 建完后用 mode=read 跑这两条核对：
--   SELECT tablename, policyname FROM pg_policies WHERE schemaname='public';
--   → 应返回 12 条策略
--   SELECT column_name FROM information_schema.columns WHERE table_name='wm_predictions';
--   → 应与 assets/site/js/store.js 的字段引用一致
