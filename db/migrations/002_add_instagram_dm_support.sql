-- Migration: Add Instagram DM support
-- Run this in psql: \i db/migrations/002_add_instagram_dm_support.sql

-- Add page_access_token to instagram_connections
ALTER TABLE instagram_connections
ADD COLUMN IF NOT EXISTS page_access_token TEXT;

-- Create Instagram DM conversations table
CREATE TABLE IF NOT EXISTS instagram_dm_conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  instagram_user_id VARCHAR(100) NOT NULL,
  instagram_username VARCHAR(255),
  last_message_at TIMESTAMP,
  unread_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create Instagram DM messages table
CREATE TABLE IF NOT EXISTS instagram_dm_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  instagram_user_id VARCHAR(100) NOT NULL,
  direction VARCHAR(10) NOT NULL, -- inbound, outbound
  message_text TEXT,
  meta_message_id VARCHAR(100),
  is_auto_reply BOOLEAN DEFAULT FALSE,
  rule_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_instagram_dm_conversations_user_id ON instagram_dm_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_instagram_dm_conversations_ig_user ON instagram_dm_conversations(user_id, instagram_user_id);
CREATE INDEX IF NOT EXISTS idx_instagram_dm_messages_conversation ON instagram_dm_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_instagram_dm_messages_user_id ON instagram_dm_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_instagram_dm_messages_created_at ON instagram_dm_messages(created_at);
