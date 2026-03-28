-- ============================================
-- ZYQORA — SUPABASE DATABASE SETUP
-- Run this in the Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================

-- ============================================
-- 1. PROFILES TABLE — linked to auth.users
-- ============================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  job_title TEXT DEFAULT '',
  plan TEXT DEFAULT 'Free',
  banned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can delete own profile" ON public.profiles;
CREATE POLICY "Users can delete own profile"
  ON public.profiles FOR DELETE
  USING (auth.uid() = id);

-- Trigger: Protect admin-only fields (role, banned, plan)
CREATE OR REPLACE FUNCTION public.protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.role := OLD.role;
    NEW.banned := OLD.banned;
    NEW.plan := OLD.plan;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_admin_fields_trigger ON public.profiles;
CREATE TRIGGER protect_admin_fields_trigger
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_admin_fields();

-- Trigger: Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _full_name TEXT;
  _role TEXT;
BEGIN
  _full_name := COALESCE(
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'name',
    ''
  );

  IF LOWER(TRIM(COALESCE(NEW.email, ''))) = 'fariodele@gmail.com' THEN
    _role := 'admin';
  ELSE
    _role := 'user';
  END IF;

  INSERT INTO public.profiles (id, full_name, email, role, job_title)
  VALUES (
    NEW.id,
    _full_name,
    COALESCE(NEW.email, ''),
    _role,
    COALESCE(NEW.raw_user_meta_data->>'job_title', '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================
-- 2. CVS TABLE — stores each CV as JSONB
-- ============================================
CREATE TABLE IF NOT EXISTS public.cvs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cv_data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cvs_user_id ON public.cvs(user_id);

ALTER TABLE public.cvs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own CVs" ON public.cvs;
CREATE POLICY "Users can read own CVs"
  ON public.cvs FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own CVs" ON public.cvs;
CREATE POLICY "Users can insert own CVs"
  ON public.cvs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own CVs" ON public.cvs;
CREATE POLICY "Users can update own CVs"
  ON public.cvs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own CVs" ON public.cvs;
CREATE POLICY "Users can delete own CVs"
  ON public.cvs FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 3. COVER_LETTERS TABLE — stores generated cover letters as JSONB
-- ============================================
CREATE TABLE IF NOT EXISTS public.cover_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cover_letters_user_id ON public.cover_letters(user_id);

ALTER TABLE public.cover_letters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own cover letters" ON public.cover_letters;
CREATE POLICY "Users can read own cover letters"
  ON public.cover_letters FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own cover letters" ON public.cover_letters;
CREATE POLICY "Users can insert own cover letters"
  ON public.cover_letters FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cover letters" ON public.cover_letters;
CREATE POLICY "Users can update own cover letters"
  ON public.cover_letters FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own cover letters" ON public.cover_letters;
CREATE POLICY "Users can delete own cover letters"
  ON public.cover_letters FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 4. ATS_REPORTS TABLE — stores ATS feedback as JSONB
-- ============================================
CREATE TABLE IF NOT EXISTS public.ats_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cv_id UUID REFERENCES public.cvs(id) ON DELETE SET NULL,
  report_data JSONB NOT NULL DEFAULT '{}',
  score NUMERIC,
  grade TEXT,
  job_description TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ats_reports_user_id ON public.ats_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_ats_reports_cv_id ON public.ats_reports(cv_id);

ALTER TABLE public.ats_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own ATS reports" ON public.ats_reports;
CREATE POLICY "Users can read own ATS reports"
  ON public.ats_reports FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own ATS reports" ON public.ats_reports;
CREATE POLICY "Users can insert own ATS reports"
  ON public.ats_reports FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own ATS reports" ON public.ats_reports;
CREATE POLICY "Users can update own ATS reports"
  ON public.ats_reports FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own ATS reports" ON public.ats_reports;
CREATE POLICY "Users can delete own ATS reports"
  ON public.ats_reports FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 5. USER DASHBOARD TABLE — stores dashboard metrics per user
-- ============================================
CREATE TABLE IF NOT EXISTS public.user_dashboard (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  ats_score NUMERIC,
  ats_date TEXT,
  career_score NUMERIC,
  career_label TEXT,
  job_matches INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_dashboard ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own dashboard" ON public.user_dashboard;
CREATE POLICY "Users can read own dashboard"
  ON public.user_dashboard FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own dashboard" ON public.user_dashboard;
CREATE POLICY "Users can insert own dashboard"
  ON public.user_dashboard FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own dashboard" ON public.user_dashboard;
CREATE POLICY "Users can update own dashboard"
  ON public.user_dashboard FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own dashboard" ON public.user_dashboard;
CREATE POLICY "Users can delete own dashboard"
  ON public.user_dashboard FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- MIGRATION: Copy data from old user_cvs table to new cvs table
-- Run this ONLY if you have existing data in user_cvs
-- ============================================
-- INSERT INTO public.cvs (id, user_id, cv_data, created_at, updated_at)
-- SELECT gen_random_uuid(), user_id, cv_data, created_at, updated_at
-- FROM public.user_cvs
-- ON CONFLICT DO NOTHING;

-- ============================================
-- ADMIN NOTES
-- ============================================
-- The designated admin (fariodele@gmail.com) is automatically assigned
-- the admin role on signup via the handle_new_user trigger.
--
-- To manually promote an existing user:
--   UPDATE public.profiles SET role = 'admin' WHERE email = 'fariodele@gmail.com';
