-- Add subscription billing tables
-- Run: psql -U postgres -d whatscrm -f db/migrations/003_add_subscription_billing.sql

CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
  period_days INTEGER DEFAULT 30 NOT NULL,
  included_services TEXT NOT NULL, -- JSON array of serviceKey strings
  max_sessions INTEGER DEFAULT 1,
  max_contacts INTEGER DEFAULT 1000,
  max_templates INTEGER DEFAULT 50,
  is_active BOOLEAN DEFAULT true NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'active' NOT NULL,
  started_at TIMESTAMP DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  razorpay_order_id VARCHAR(255),
  razorpay_payment_id VARCHAR(255),
  amount_paid INTEGER DEFAULT 0,
  invoice_id INTEGER,
  auto_renew BOOLEAN DEFAULT false,
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_expires_at ON user_subscriptions(expires_at);

-- Insert default subscription plans
INSERT INTO subscription_plans (name, display_name, description, price, period_days, included_services, max_sessions, max_contacts, max_templates, sort_order)
VALUES
  ('starter_monthly', 'Starter Monthly', 'Basic monthly plan for small businesses', 499, 30, '["send_message","incoming_message","create_contact","create_template","schedule_message"]', 1, 500, 10, 1),
  ('pro_monthly', 'Pro Monthly', 'Professional plan with unlimited messaging', 999, 30, '["send_message","poll_message","incoming_message","ai_reply","create_contact","create_template","scrape","schedule_message","auto_reply","create_session","social_automation","webhook","create_form","lead_import","send_email","create_email_template","create_email_automation"]', 3, 5000, 50, 2),
  ('business_monthly', 'Business Monthly', 'Full-featured plan for growing teams', 2499, 30, '["send_message","poll_message","incoming_message","ai_reply","create_contact","create_template","scrape","schedule_message","auto_reply","create_session","social_automation","api_key","webhook","create_form","lead_import","youtube_rule","instagram_rule","send_email","create_email_template","create_email_automation","whatsapp_api_message","whatsapp_api_template","session_questionnaire"]', 10, 20000, 200, 3)
ON CONFLICT (name) DO NOTHING;
