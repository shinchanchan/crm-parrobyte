-- Performance indexes for ParroByte CRM
-- Run these in psql to optimize common queries

-- Messages (frequently filtered by user)
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

-- Contacts (frequently filtered by user)
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);

-- Leads (frequently filtered by user)
CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);

-- Credit transactions (frequently filtered by user + service + date)
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_service_key ON credit_transactions(service_key);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON credit_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_service ON credit_transactions(user_id, service_key, created_at);

-- Scheduled messages (cron job scans every minute)
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status_time ON scheduled_messages(status, schedule_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user_id ON scheduled_messages(user_id);

-- AI message queue (background processor scans every 10s)
CREATE INDEX IF NOT EXISTS idx_ai_message_queue_status_user ON ai_message_queue(status, user_id);
CREATE INDEX IF NOT EXISTS idx_ai_message_queue_created_at ON ai_message_queue(created_at);

-- Webhooks (filtered by user + active)
CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_session_id ON webhooks(session_id);

-- Webhook logs (frequently queried by webhook_id)
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id ON webhook_logs(webhook_id);

-- Scheduled emails (cron job scans every minute)
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_status_time ON scheduled_emails(status, scheduled_at);

-- WhatsApp sessions (frequently filtered by user)
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user_id ON whatsapp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_status ON whatsapp_sessions(status);

-- Templates (filtered by user)
CREATE INDEX IF NOT EXISTS idx_templates_user_id ON templates(user_id);

-- Auto replies (filtered by user + active)
CREATE INDEX IF NOT EXISTS idx_auto_replies_user_id ON auto_replies(user_id);

-- Invoices (filtered by user)
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);

-- Activity logs (filtered by user)
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);

-- Email messages (filtered by user)
CREATE INDEX IF NOT EXISTS idx_email_messages_user_id ON email_messages(user_id);

-- Bulk message jobs (filtered by user)
CREATE INDEX IF NOT EXISTS idx_bulk_message_jobs_user_id ON bulk_message_jobs(user_id);

-- Scraped businesses (filtered by user + job)
CREATE INDEX IF NOT EXISTS idx_scraped_businesses_user_id ON scraped_businesses(user_id);
CREATE INDEX IF NOT EXISTS idx_scraped_businesses_job_id ON scraped_businesses(job_id);
