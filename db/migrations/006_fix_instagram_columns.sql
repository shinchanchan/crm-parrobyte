-- Fix Instagram Automation: Add missing columns and tables
-- Run with: psql -d whatscrm -f db/migrations/006_fix_instagram_columns.sql

-- ============================================
-- Fix instagram_connections table
-- ============================================

-- Add missing columns if they don't exist
DO $$
BEGIN
    -- page_id
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'page_id'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN page_id VARCHAR(100);
    END IF;

    -- page_name
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'page_name'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN page_name VARCHAR(255);
    END IF;

    -- page_access_token
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'page_access_token'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN page_access_token TEXT;
    END IF;

    -- instagram_id
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'instagram_id'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN instagram_id VARCHAR(100);
    END IF;

    -- instagram_username
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'instagram_username'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN instagram_username VARCHAR(255);
    END IF;

    -- access_token
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'access_token'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN access_token TEXT;
    END IF;

    -- token_expiry
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'token_expiry'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN token_expiry TIMESTAMP;
    END IF;

    -- is_active
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'is_active'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN is_active BOOLEAN DEFAULT FALSE NOT NULL;
    END IF;

    -- last_fetch_at
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'last_fetch_at'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN last_fetch_at TIMESTAMP;
    END IF;

    -- created_at
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'created_at'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN created_at TIMESTAMP DEFAULT NOW() NOT NULL;
    END IF;

    -- updated_at
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'instagram_connections' AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE instagram_connections ADD COLUMN updated_at TIMESTAMP DEFAULT NOW() NOT NULL;
    END IF;
END $$;

-- Ensure unique constraint on user_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE indexname = 'instagram_connections_user_id_unique'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE indexname = 'instagram_connections_user_id_key'
    ) THEN
        CREATE UNIQUE INDEX instagram_connections_user_id_unique ON instagram_connections(user_id);
    END IF;
END $$;

-- ============================================
-- Create instagram_reply_rules table
-- ============================================
CREATE TABLE IF NOT EXISTS instagram_reply_rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  trigger_type VARCHAR(20) DEFAULT 'contains' NOT NULL,
  trigger_value VARCHAR(500) NOT NULL,
  response_content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instagram_reply_rules_user ON instagram_reply_rules(user_id);

-- ============================================
-- Create instagram_replied_comments table
-- ============================================
CREATE TABLE IF NOT EXISTS instagram_replied_comments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  media_id VARCHAR(100) NOT NULL,
  comment_id VARCHAR(100) NOT NULL UNIQUE,
  comment_text TEXT,
  reply_text TEXT,
  rule_id INTEGER,
  replied_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instagram_replied_comments_user ON instagram_replied_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_instagram_replied_comments_comment_id ON instagram_replied_comments(comment_id);

-- ============================================
-- Create instagram_dm_conversations table
-- ============================================
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

CREATE INDEX IF NOT EXISTS idx_instagram_dm_conversations_user_id ON instagram_dm_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_instagram_dm_conversations_ig_user ON instagram_dm_conversations(user_id, instagram_user_id);

-- ============================================
-- Create instagram_dm_messages table
-- ============================================
CREATE TABLE IF NOT EXISTS instagram_dm_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  instagram_user_id VARCHAR(100) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  message_text TEXT,
  meta_message_id VARCHAR(100),
  is_auto_reply BOOLEAN DEFAULT FALSE,
  rule_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instagram_dm_messages_conversation ON instagram_dm_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_instagram_dm_messages_user_id ON instagram_dm_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_instagram_dm_messages_created_at ON instagram_dm_messages(created_at);
