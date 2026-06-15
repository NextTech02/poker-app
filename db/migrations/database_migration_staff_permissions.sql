-- Migration: Staff & Permission Groups
-- Description: RBAC system for controlling which screens each user can access

-- =============================================
-- 1. Permission Groups
-- =============================================
CREATE TABLE IF NOT EXISTS permission_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    permissions TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- 2. Staff
-- =============================================
CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    permission_group_id UUID REFERENCES permission_groups(id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- 3. Indexes
-- =============================================
CREATE INDEX IF NOT EXISTS idx_staff_auth_user ON staff(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_staff_group ON staff(permission_group_id);

-- =============================================
-- 4. RLS Policies
-- =============================================
ALTER TABLE permission_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_groups" ON permission_groups FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_groups" ON permission_groups FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_groups" ON permission_groups FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_delete_groups" ON permission_groups FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_read_staff" ON staff FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_staff" ON staff FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_staff" ON staff FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_delete_staff" ON staff FOR DELETE TO authenticated USING (true);

-- =============================================
-- 5. Default Admin Group
-- =============================================
INSERT INTO permission_groups (name, description, permissions)
VALUES (
    'Admin',
    'Acesso total ao sistema',
    ARRAY['dashboard','stages','tournaments','players','cashier','cashier_players','cashier_tickets','prizes','financial','reports','general_cash','rankings','blinds','tables','broadcast','employees']
) ON CONFLICT (name) DO NOTHING;
