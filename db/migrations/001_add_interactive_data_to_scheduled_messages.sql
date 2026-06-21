-- Migration: Add interactive_data column to scheduled_messages for poll support
-- Run with: psql -d whatscrm -f db/migrations/001_add_interactive_data_to_scheduled_messages.sql

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS interactive_data TEXT;
