
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "advertisers": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"name": string,"network": string | null,"notes": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"network"?: string | null,"notes"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"network"?: string | null,"notes"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"approvals": {
                  Row: {
                    "action": Database["public"]['Enums']["approval_action"],"at": string,"by": string,"created_at": string,"created_by": string | null,"entity_id": string,"entity_type": Database["public"]['Enums']["approval_entity"],"id": string,"note": string | null,"updated_at": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "action": Database["public"]['Enums']["approval_action"],"at"?: string,"by": string,"created_at"?: string,"created_by"?: string | null,"entity_id": string,"entity_type": Database["public"]['Enums']["approval_entity"],"id"?: string,"note"?: string | null,"updated_at"?: string,"version": number
                  }
                  Update: {
                    "action"?: Database["public"]['Enums']["approval_action"],"at"?: string,"by"?: string,"created_at"?: string,"created_by"?: string | null,"entity_id"?: string,"entity_type"?: Database["public"]['Enums']["approval_entity"],"id"?: string,"note"?: string | null,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "approvals_by_fkey"
      columns: ["by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_log": {
                  Row: {
                    "action": string,"actor": string | null,"after": Json | null,"at": string,"before": Json | null,"created_at": string,"created_by": string | null,"entity_id": string | null,"entity_type": string,"id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"created_at"?: string,"created_by"?: string | null,"entity_id"?: string | null,"entity_type": string,"id"?: string,"updated_at"?: string
                  }
                  Update: {
                    "action"?: string,"actor"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"created_at"?: string,"created_by"?: string | null,"entity_id"?: string | null,"entity_type"?: string,"id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"offer_urls": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"kind": Database["public"]['Enums']["offer_url_kind"],"offer_version_id": string,"updated_at": string,"url": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["offer_url_kind"],"offer_version_id": string,"updated_at"?: string,"url": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["offer_url_kind"],"offer_version_id"?: string,"updated_at"?: string,"url"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "offer_urls_offer_version_id_fkey"
      columns: ["offer_version_id"]
isOneToOne: false
      referencedRelation: "offer_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "offer_urls_offer_version_id_fkey"
      columns: ["offer_version_id"]
isOneToOne: false
      referencedRelation: "offer_versions_with_economics"
      referencedColumns: ["id"]
    }
                  ]
                },"offer_version_economics": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"offer_version_id": string,"payout_tiers": Json | null,"target_cpl": number | null,"target_roi": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"offer_version_id": string,"payout_tiers"?: Json | null,"target_cpl"?: number | null,"target_roi"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"offer_version_id"?: string,"payout_tiers"?: Json | null,"target_cpl"?: number | null,"target_roi"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "offer_version_economics_offer_version_id_fkey"
      columns: ["offer_version_id"]
isOneToOne: true
      referencedRelation: "offer_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "offer_version_economics_offer_version_id_fkey"
      columns: ["offer_version_id"]
isOneToOne: true
      referencedRelation: "offer_versions_with_economics"
      referencedColumns: ["id"]
    }
                  ]
                },"offer_versions": {
                  Row: {
                    "approval_required": boolean | null,"approved_at": string | null,"approved_by": string | null,"call_hours": Json | null,"cap_amount": number | null,"cap_counts": Database["public"]['Enums']["cap_counts"] | null,"cap_period": Database["public"]['Enums']["cap_period"] | null,"created_at": string,"created_by": string | null,"feedback_delay_days": number | null,"id": string,"offer_id": string,"optimisation_event": string | null,"payout_model": Database["public"]['Enums']["payout_model"] | null,"restrictions": Json | null,"states": (string)[] | null,"status": Database["public"]['Enums']["offer_version_status"],"updated_at": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "approval_required"?: boolean | null,"approved_at"?: string | null,"approved_by"?: string | null,"call_hours"?: Json | null,"cap_amount"?: number | null,"cap_counts"?: Database["public"]['Enums']["cap_counts"] | null,"cap_period"?: Database["public"]['Enums']["cap_period"] | null,"created_at"?: string,"created_by"?: string | null,"feedback_delay_days"?: number | null,"id"?: string,"offer_id": string,"optimisation_event"?: string | null,"payout_model"?: Database["public"]['Enums']["payout_model"] | null,"restrictions"?: Json | null,"states"?: (string)[] | null,"status"?: Database["public"]['Enums']["offer_version_status"],"updated_at"?: string,"version": number
                  }
                  Update: {
                    "approval_required"?: boolean | null,"approved_at"?: string | null,"approved_by"?: string | null,"call_hours"?: Json | null,"cap_amount"?: number | null,"cap_counts"?: Database["public"]['Enums']["cap_counts"] | null,"cap_period"?: Database["public"]['Enums']["cap_period"] | null,"created_at"?: string,"created_by"?: string | null,"feedback_delay_days"?: number | null,"id"?: string,"offer_id"?: string,"optimisation_event"?: string | null,"payout_model"?: Database["public"]['Enums']["payout_model"] | null,"restrictions"?: Json | null,"states"?: (string)[] | null,"status"?: Database["public"]['Enums']["offer_version_status"],"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "offer_versions_approved_by_fkey"
      columns: ["approved_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "offer_versions_offer_id_fkey"
      columns: ["offer_id"]
isOneToOne: false
      referencedRelation: "offers"
      referencedColumns: ["id"]
    }
                  ]
                },"offers": {
                  Row: {
                    "advertiser_id": string | null,"created_at": string,"created_by": string | null,"current_version_id": string | null,"id": string,"name": string,"owner_id": string,"status": Database["public"]['Enums']["offer_status"],"updated_at": string,"vertical": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "advertiser_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"current_version_id"?: string | null,"id"?: string,"name": string,"owner_id"?: string,"status"?: Database["public"]['Enums']["offer_status"],"updated_at"?: string,"vertical"?: string | null
                  }
                  Update: {
                    "advertiser_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"current_version_id"?: string | null,"id"?: string,"name"?: string,"owner_id"?: string,"status"?: Database["public"]['Enums']["offer_status"],"updated_at"?: string,"vertical"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "offers_advertiser_id_fkey"
      columns: ["advertiser_id"]
isOneToOne: false
      referencedRelation: "advertisers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "offers_current_version_fkey"
      columns: ["id","current_version_id"]
isOneToOne: false
      referencedRelation: "offer_versions"
      referencedColumns: ["offer_id","id"]
    },{
      foreignKeyName: "offers_current_version_fkey"
      columns: ["id","current_version_id"]
isOneToOne: false
      referencedRelation: "offer_versions_with_economics"
      referencedColumns: ["offer_id","id"]
    },{
      foreignKeyName: "offers_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "active": boolean,"created_at": string,"created_by": string | null,"display_name": string,"id": string,"role": Database["public"]['Enums']["app_role"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"display_name": string,"id": string,"role"?: Database["public"]['Enums']["app_role"],"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"display_name"?: string,"id"?: string,"role"?: Database["public"]['Enums']["app_role"],"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "offer_versions_with_economics": {
                  Row: {
                    "approval_required": boolean | null,"approved_at": string | null,"approved_by": string | null,"call_hours": Json | null,"cap_amount": number | null,"cap_counts": Database["public"]['Enums']["cap_counts"] | null,"cap_period": Database["public"]['Enums']["cap_period"] | null,"created_at": string,"created_by": string | null,"feedback_delay_days": number | null,"id": string,"offer_id": string,"optimisation_event": string | null,"payout_model": Database["public"]['Enums']["payout_model"] | null,"payout_tiers": Json | null,"restrictions": Json | null,"states": (string)[] | null,"status": Database["public"]['Enums']["offer_version_status"],"target_cpl": number | null,"target_roi": number | null,"updated_at": string,"version": number
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "offer_versions_approved_by_fkey"
      columns: ["approved_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "offer_versions_offer_id_fkey"
      columns: ["offer_id"]
isOneToOne: false
      referencedRelation: "offers"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "approve_offer_version":
{ Args: { "p_note"?: string,"p_version_id": string }; Returns: string
                           },
"bootstrap_admin":
{ Args: { "target_user_id": string }; Returns: boolean
                           },
"create_draft_from_approved":
{ Args: { "p_offer_id": string }; Returns: string
                           },
"reassign_offer_owner":
{ Args: { "p_new_owner_id": string,"p_offer_id": string }; Returns: string
                           },
"save_offer_draft":
{ Args: { "p_economics"?: Json,"p_offer"?: Json,"p_offer_id"?: string,"p_urls"?: Json,"p_version"?: Json }; Returns: Json
                           }
          }
          Enums: {
            "app_role": "admin"|"manager"|"buyer"|"creative","approval_action": "approved"|"rejected"|"changes_requested","approval_entity": "offer_version","cap_counts": "submissions"|"qualified"|"billable"|"calls","cap_period": "day"|"week"|"month"|"total","offer_status": "active"|"paused"|"archived","offer_url_kind": "our_lander"|"offer_page"|"preview"|"competitor_lander"|"other","offer_version_status": "draft"|"approved","payout_model": "cpl"|"cpql"|"cpa"|"revshare"|"ppc"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "app_role": ["admin", "manager", "buyer", "creative"],"approval_action": ["approved", "rejected", "changes_requested"],"approval_entity": ["offer_version"],"cap_counts": ["submissions", "qualified", "billable", "calls"],"cap_period": ["day", "week", "month", "total"],"offer_status": ["active", "paused", "archived"],"offer_url_kind": ["our_lander", "offer_page", "preview", "competitor_lander", "other"],"offer_version_status": ["draft", "approved"],"payout_model": ["cpl", "cpql", "cpa", "revshare", "ppc"]
          }
        }
} as const
