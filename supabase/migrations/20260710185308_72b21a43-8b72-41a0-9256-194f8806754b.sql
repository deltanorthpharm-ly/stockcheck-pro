
-- Enum + tables first, policies after
CREATE TYPE public.app_role AS ENUM ('admin', 'employee');

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);

CREATE TABLE public.inventory_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  exported_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.inventory_sessions(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  item_name_raw TEXT NOT NULL,
  barcode TEXT,
  selling_price NUMERIC,
  expiry_date TEXT,
  system_quantity_raw TEXT,
  system_boxes INTEGER NOT NULL DEFAULT 0,
  system_strips INTEGER NOT NULL DEFAULT 0,
  system_units INTEGER NOT NULL DEFAULT 0,
  quantity_parse_status TEXT NOT NULL DEFAULT 'empty'
    CHECK (quantity_parse_status IN ('parsed','partial','unrecognized','empty')),
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_items_session_idx ON public.inventory_items(session_id);
CREATE INDEX inventory_items_assigned_idx ON public.inventory_items(assigned_to);
CREATE INDEX inventory_items_session_row_idx ON public.inventory_items(session_id, row_index);

CREATE TABLE public.inventory_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.inventory_sessions(id) ON DELETE CASCADE,
  counted_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  phys_boxes INTEGER NOT NULL DEFAULT 0,
  phys_strips INTEGER NOT NULL DEFAULT 0,
  phys_units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  count_version INTEGER NOT NULL DEFAULT 1,
  is_current BOOLEAN NOT NULL DEFAULT true,
  client_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_counts_item_idx ON public.inventory_counts(item_id);
CREATE INDEX inventory_counts_session_idx ON public.inventory_counts(session_id);
CREATE INDEX inventory_counts_current_idx ON public.inventory_counts(item_id) WHERE is_current;
CREATE UNIQUE INDEX inventory_counts_client_op_idx ON public.inventory_counts(counted_by, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_sessions TO authenticated;
GRANT ALL ON public.inventory_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_items TO authenticated;
GRANT ALL ON public.inventory_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_counts TO authenticated;
GRANT ALL ON public.inventory_counts TO service_role;

-- has_role helper
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_counts ENABLE ROW LEVEL SECURITY;

-- Policies: profiles
CREATE POLICY "profiles_self_select" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "profiles_admin_all" ON public.profiles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Policies: user_roles
CREATE POLICY "roles_self_select" ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- Policies: sessions
CREATE POLICY "sessions_admin_all" ON public.inventory_sessions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "sessions_employee_select" ON public.inventory_sessions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.inventory_items i
    WHERE i.session_id = inventory_sessions.id AND i.assigned_to = auth.uid()
  ));

-- Policies: items
CREATE POLICY "items_admin_all" ON public.inventory_items
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "items_employee_select" ON public.inventory_items
  FOR SELECT TO authenticated
  USING (assigned_to = auth.uid());

-- Policies: counts
CREATE POLICY "counts_admin_all" ON public.inventory_counts
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "counts_employee_select" ON public.inventory_counts
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.inventory_items i
    WHERE i.id = inventory_counts.item_id AND i.assigned_to = auth.uid()
  ));
CREATE POLICY "counts_employee_insert" ON public.inventory_counts
  FOR INSERT TO authenticated
  WITH CHECK (
    counted_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.inventory_items i
                JOIN public.inventory_sessions s ON s.id = i.session_id
                WHERE i.id = inventory_counts.item_id
                  AND i.assigned_to = auth.uid()
                  AND s.status = 'open')
  );
CREATE POLICY "counts_employee_update" ON public.inventory_counts
  FOR UPDATE TO authenticated
  USING (
    counted_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.inventory_items i
                JOIN public.inventory_sessions s ON s.id = i.session_id
                WHERE i.id = inventory_counts.item_id
                  AND i.assigned_to = auth.uid()
                  AND s.status = 'open')
  );

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER trg_inventory_counts_updated_at
BEFORE UPDATE ON public.inventory_counts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
