export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      inventory_counts: {
        Row: {
          client_operation_id: string | null
          count_version: number
          counted_by: string
          created_at: string
          diff_status: string | null
          difference_boxes: number | null
          difference_raw: number | null
          difference_units: number | null
          id: string
          is_current: boolean
          item_id: string
          opened_at: string | null
          pack_size_at_open: number | null
          pack_size_at_submit: number | null
          phys_boxes: number
          phys_strips: number
          phys_units: number
          physical_raw_quantity: number | null
          raw_quantity_at_open: number | null
          raw_quantity_at_submit: number | null
          recount_reason: string | null
          requires_recount: boolean
          session_id: string
          source_read_at_open: string | null
          source_read_at_submit: string | null
          status: string
          submitted_at: string | null
          system_boxes_at_open: number | null
          system_boxes_at_submit: number | null
          system_units_at_open: number | null
          system_units_at_submit: number | null
          updated_at: string
        }
        Insert: {
          client_operation_id?: string | null
          count_version?: number
          counted_by: string
          created_at?: string
          diff_status?: string | null
          difference_boxes?: number | null
          difference_raw?: number | null
          difference_units?: number | null
          id?: string
          is_current?: boolean
          item_id: string
          opened_at?: string | null
          pack_size_at_open?: number | null
          pack_size_at_submit?: number | null
          phys_boxes?: number
          phys_strips?: number
          phys_units?: number
          physical_raw_quantity?: number | null
          raw_quantity_at_open?: number | null
          raw_quantity_at_submit?: number | null
          recount_reason?: string | null
          requires_recount?: boolean
          session_id: string
          source_read_at_open?: string | null
          source_read_at_submit?: string | null
          status?: string
          submitted_at?: string | null
          system_boxes_at_open?: number | null
          system_boxes_at_submit?: number | null
          system_units_at_open?: number | null
          system_units_at_submit?: number | null
          updated_at?: string
        }
        Update: {
          client_operation_id?: string | null
          count_version?: number
          counted_by?: string
          created_at?: string
          diff_status?: string | null
          difference_boxes?: number | null
          difference_raw?: number | null
          difference_units?: number | null
          id?: string
          is_current?: boolean
          item_id?: string
          opened_at?: string | null
          pack_size_at_open?: number | null
          pack_size_at_submit?: number | null
          phys_boxes?: number
          phys_strips?: number
          phys_units?: number
          physical_raw_quantity?: number | null
          raw_quantity_at_open?: number | null
          raw_quantity_at_submit?: number | null
          recount_reason?: string | null
          requires_recount?: boolean
          session_id?: string
          source_read_at_open?: string | null
          source_read_at_submit?: string | null
          status?: string
          submitted_at?: string | null
          system_boxes_at_open?: number | null
          system_boxes_at_submit?: number | null
          system_units_at_open?: number | null
          system_units_at_submit?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_counts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "inventory_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          assigned_to: string | null
          barcode: string | null
          conversion_status: string | null
          created_at: string
          expiry_date: string | null
          external_item_id: string | null
          formatted_quantity_snapshot: string | null
          id: string
          item_name_raw: string
          pack_size: number | null
          quantity_parse_status: string
          raw_quantity_snapshot: number | null
          row_index: number
          selling_price: number | null
          session_id: string
          source_read_at: string | null
          system_boxes: number
          system_boxes_snapshot: number | null
          system_quantity_raw: string | null
          system_strips: number
          system_units: number
          system_units_snapshot: number | null
        }
        Insert: {
          assigned_to?: string | null
          barcode?: string | null
          conversion_status?: string | null
          created_at?: string
          expiry_date?: string | null
          external_item_id?: string | null
          formatted_quantity_snapshot?: string | null
          id?: string
          item_name_raw: string
          pack_size?: number | null
          quantity_parse_status?: string
          raw_quantity_snapshot?: number | null
          row_index: number
          selling_price?: number | null
          session_id: string
          source_read_at?: string | null
          system_boxes?: number
          system_boxes_snapshot?: number | null
          system_quantity_raw?: string | null
          system_strips?: number
          system_units?: number
          system_units_snapshot?: number | null
        }
        Update: {
          assigned_to?: string | null
          barcode?: string | null
          conversion_status?: string | null
          created_at?: string
          expiry_date?: string | null
          external_item_id?: string | null
          formatted_quantity_snapshot?: string | null
          id?: string
          item_name_raw?: string
          pack_size?: number | null
          quantity_parse_status?: string
          raw_quantity_snapshot?: number | null
          row_index?: number
          selling_price?: number | null
          session_id?: string
          source_read_at?: string | null
          system_boxes?: number
          system_boxes_snapshot?: number | null
          system_quantity_raw?: string | null
          system_strips?: number
          system_units?: number
          system_units_snapshot?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "inventory_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_sessions: {
        Row: {
          closed_at: string | null
          created_at: string
          created_by: string
          exported_at: string | null
          id: string
          name: string
          source_type: string
          status: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          created_by: string
          exported_at?: string | null
          id?: string
          name: string
          source_type?: string
          status?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          created_by?: string
          exported_at?: string | null
          id?: string
          name?: string
          source_type?: string
          status?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          created_by: string | null
          display_name: string
          id: string
          pin: string | null
          username: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          display_name: string
          id: string
          pin?: string | null
          username: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          display_name?: string
          id?: string
          pin?: string | null
          username?: string
        }
        Relationships: []
      }
      teryaq_health_pings: {
        Row: {
          checked_at: string
          checked_by: string | null
          error: string | null
          id: string
          latency_ms: number | null
          ok: boolean
        }
        Insert: {
          checked_at?: string
          checked_by?: string | null
          error?: string | null
          id?: string
          latency_ms?: number | null
          ok: boolean
        }
        Update: {
          checked_at?: string
          checked_by?: string | null
          error?: string | null
          id?: string
          latency_ms?: number | null
          ok?: boolean
        }
        Relationships: []
      }
      teryaq_sync_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: string
          items_synced: number
          page_cursor: number
          session_id: string
          started_at: string
          started_by: string
          status: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: string
          items_synced?: number
          page_cursor?: number
          session_id: string
          started_at?: string
          started_by: string
          status: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: string
          items_synced?: number
          page_cursor?: number
          session_id?: string
          started_at?: string
          started_by?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "teryaq_sync_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "inventory_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "employee"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "employee"],
    },
  },
} as const
