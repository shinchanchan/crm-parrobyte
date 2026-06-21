import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  pgEnum,
  numeric,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const planEnum = pgEnum("plan", ["free", "silver", "gold", "platinum"]);
export const statusEnum = pgEnum("status", ["connecting", "connected", "disconnected", "qr_ready"]);
export const messageTypeEnum = pgEnum("message_type", ["text", "image", "document", "video", "audio", "buttons", "list", "poll"]);
export const messageStatusEnum = pgEnum("message_status", ["pending", "queued", "sending", "sent", "failed", "delivered"]);
export const scheduleStatusEnum = pgEnum("schedule_status", ["pending", "processing", "completed", "cancelled"]);
export const triggerTypeEnum = pgEnum("trigger_type", ["exact", "contains", "starts_with", "ends_with", "regex"]);
export const responseTypeEnum = pgEnum("response_type", ["static", "ai"]);
export const queueStatusEnum = pgEnum("queue_status", ["queued", "processing", "sent", "failed"]);
export const bulkStatusEnum = pgEnum("bulk_status", ["processing", "completed", "failed"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["pending", "paid", "failed", "refunded"]);
export const leadSourceEnum = pgEnum("lead_source", ["form", "scraper", "manual", "api", "poll_vote"]);
export const leadStatusEnum = pgEnum("lead_status", ["new", "contacted", "qualified", "converted", "lost"]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "completed", "failed"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  avatar: text("avatar"),
  role: roleEnum("role").default("user").notNull(),
  credits: numeric("credits", { precision: 10, scale: 2 }).default("0").notNull(),
  totalSpent: integer("total_spent").default(0),
  plan: planEnum("plan").default("free").notNull(),
  planExpiry: timestamp("plan_expiry"),
  countryCode: varchar("country_code", { length: 10 }).default("+1"),
  timezone: varchar("timezone", { length: 50 }).default("UTC"),
  themeColor: varchar("theme_color", { length: 7 }).default("#ec4899"),
  maxSessions: integer("max_sessions").default(1), // Admin override for WhatsApp session limit (default 1, null = use plan default)
  isActive: boolean("is_active").default(true).notNull(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  emailOtp: varchar("email_otp", { length: 6 }),
  emailOtpExpiry: timestamp("email_otp_expiry"),
  passwordResetToken: varchar("password_reset_token", { length: 255 }),
  passwordResetExpiry: timestamp("password_reset_expiry"),
  sessionToken: varchar("session_token", { length: 255 }),
  lastLogin: timestamp("last_login"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const plans = pgTable("plans", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  price: integer("price").default(0),
  period: varchar("period", { length: 20 }).default("monthly"),
  maxSessions: integer("max_sessions").default(1),
  maxContacts: integer("max_contacts").default(100),
  maxTemplates: integer("max_templates").default(5),
  maxScrapeRecords: integer("max_scrape_records").default(10),
  features: text("features"),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  planName: varchar("plan_name", { length: 50 }).notNull(),
  amount: integer("amount").notNull(),
  currency: varchar("currency", { length: 10 }).default("USD"),
  status: invoiceStatusEnum("status").default("pending").notNull(),
  paymentMethod: varchar("payment_method", { length: 50 }),
  transactionId: varchar("transaction_id", { length: 255 }),
  razorpayOrderId: varchar("razorpay_order_id", { length: 255 }),
  notes: text("notes"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Credit-based billing configuration
export const creditConfigs = pgTable("credit_configs", {
  id: serial("id").primaryKey(),
  serviceKey: varchar("service_key", { length: 50 }).notNull().unique(),
  serviceName: varchar("service_name", { length: 100 }).notNull(),
  cost: numeric("cost", { precision: 10, scale: 2 }).default("1").notNull(),
  freeQuota: integer("free_quota").default(0),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  isVisible: boolean("is_visible").default(true).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// Credit transaction history
export const creditTransactions = pgTable("credit_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  type: varchar("type", { length: 20 }).notNull(), // debit, credit, topup, bonus
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(), // positive for credit, negative for debit
  balanceAfter: numeric("balance_after", { precision: 10, scale: 2 }).notNull(),
  serviceKey: varchar("service_key", { length: 50 }), // which service consumed credits
  description: text("description"),
  referenceId: integer("reference_id"), // related record id (message, contact, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const whatsappSessions = pgTable("whatsapp_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionName: varchar("session_name", { length: 255 }).notNull(),
  phoneNumber: varchar("phone_number", { length: 50 }),
  status: statusEnum("status").default("connecting").notNull(),
  qrCode: text("qr_code"),
  lastActivity: timestamp("last_activity").defaultNow(),
  disconnectAlertSent: boolean("disconnect_alert_sent").default(false),
  isShared: boolean("is_shared").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }).notNull(),
  countryCode: varchar("country_code", { length: 10 }).default("+1"),
  email: varchar("email", { length: 320 }),
  group: varchar("group_name", { length: 100 }).default("default"),
  tags: text("tags"),
  notes: text("notes"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const templates = pgTable("templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  type: messageTypeEnum("type").default("text").notNull(),
  content: text("content").notNull(),
  mediaUrl: text("media_url"),
  mediaCaption: varchar("media_caption", { length: 500 }),
  variables: text("variables"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id").notNull(),
  contactId: integer("contact_id"),
  phone: varchar("phone", { length: 50 }).notNull(),
  type: messageTypeEnum("type").default("text").notNull(),
  content: text("content").notNull(),
  mediaUrl: text("media_url"),
  interactiveData: text("interactive_data"), // JSON: buttons or list config
  status: messageStatusEnum("status").default("pending").notNull(),
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const scheduledMessages = pgTable("scheduled_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id").notNull(),
  templateId: integer("template_id"),
  contactIds: text("contact_ids").notNull(),
  type: messageTypeEnum("type").default("text").notNull(),
  content: text("content").notNull(),
  mediaUrl: text("media_url"),
  interactiveData: text("interactive_data"),
  scheduleTime: timestamp("schedule_time").notNull(),
  timezone: varchar("timezone", { length: 50 }).default("UTC"),
  status: scheduleStatusEnum("status").default("pending").notNull(),
  repeatPattern: varchar("repeat_pattern", { length: 50 }),
  repeatUntil: timestamp("repeat_until"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const autoReplies = pgTable("auto_replies", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id"),
  name: varchar("name", { length: 255 }).notNull(),
  triggerType: triggerTypeEnum("trigger_type").default("contains").notNull(),
  triggerValue: varchar("trigger_value", { length: 500 }).notNull(),
  responseType: responseTypeEnum("response_type").default("static").notNull(),
  responseContent: text("response_content").notNull(),
  aiPrompt: text("ai_prompt"),
  isActive: boolean("is_active").default(true).notNull(),
  priority: integer("priority").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  keyName: varchar("key_name", { length: 255 }).notNull(),
  apiKey: varchar("api_key", { length: 255 }).notNull().unique(),
  sessionId: integer("session_id"),
  permissions: text("permissions"),
  lastUsed: timestamp("last_used"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const webhooks = pgTable("webhooks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id"),
  name: varchar("name", { length: 255 }).notNull(),
  url: text("url").notNull(),
  events: text("events").notNull(),
  secret: varchar("secret", { length: 255 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const webhookLogs = pgTable("webhook_logs", {
  id: serial("id").primaryKey(),
  webhookId: integer("webhook_id").notNull(),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  payload: text("payload"),
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messageQueue = pgTable("message_queue", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id").notNull(),
  contactId: integer("contact_id"),
  phone: varchar("phone", { length: 50 }).notNull(),
  type: messageTypeEnum("type").default("text").notNull(),
  content: text("content").notNull(),
  mediaUrl: text("media_url"),
  status: queueStatusEnum("status").default("queued").notNull(),
  retryCount: integer("retry_count").default(0),
  scheduledAt: timestamp("scheduled_at"),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const activityLogs = pgTable("activity_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  entity: varchar("entity", { length: 100 }),
  entityId: integer("entity_id"),
  details: text("details"),
  ipAddress: varchar("ip_address", { length: 50 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const bulkUploads = pgTable("bulk_uploads", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  totalRecords: integer("total_records").default(0),
  successCount: integer("success_count").default(0),
  failCount: integer("fail_count").default(0),
  status: bulkStatusEnum("status").default("processing").notNull(),
  errors: text("errors"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const enquiryForms = pgTable("enquiry_forms", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  description: text("description"),
  primaryColor: varchar("primary_color", { length: 7 }).default("#ec4899"),
  bgColor: varchar("bg_color", { length: 7 }).default("#ffffff"),
  textColor: varchar("text_color", { length: 7 }).default("#1f2937"),
  fields: text("fields").notNull(),
  buttonText: varchar("button_text", { length: 100 }).default("Submit"),
  thankYouMessage: text("thank_you_message").default("Thank you! We will contact you soon."),
  testimonials: text("testimonials").default("[]"),
  bgMediaType: varchar("bg_media_type", { length: 10 }),
  bgMediaData: text("bg_media_data"),
  isActive: boolean("is_active").default(true).notNull(),
  submitCount: integer("submit_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  formId: integer("form_id"),
  source: leadSourceEnum("source").default("manual").notNull(),
  name: varchar("name", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  countryCode: varchar("country_code", { length: 10 }).default("+1"),
  data: text("data"),
  status: leadStatusEnum("status").default("new").notNull(),
  notes: text("notes"),
  tags: text("tags"),
  lastContactedAt: timestamp("last_contacted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const scrapingJobs = pgTable("scraping_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  query: varchar("query", { length: 255 }).notNull(),
  location: varchar("location", { length: 255 }).notNull(),
  maxResults: integer("max_results").default(10),
  status: jobStatusEnum("status").default("pending").notNull(),
  recordsFound: integer("records_found").default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const scrapedBusinesses = pgTable("scraped_businesses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  jobId: integer("job_id"),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  address: text("address"),
  website: text("website"),
  category: varchar("category", { length: 100 }),
  sourceUrl: text("source_url"),
  importedToLeads: boolean("imported_to_leads").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const bulkMessageJobs = pgTable("bulk_message_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id").notNull(),
  templateId: integer("template_id"),
  content: text("content").notNull(),
  type: messageTypeEnum("type").default("text").notNull(),
  mediaUrl: text("media_url"),
  totalContacts: integer("total_contacts").default(0),
  sentCount: integer("sent_count").default(0),
  failedCount: integer("failed_count").default(0),
  gapSeconds: integer("gap_seconds").default(45),
  status: bulkStatusEnum("status").default("processing").notNull(),
  contactIds: text("contact_ids"),
  interactiveData: text("interactive_data"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pollAutoResponses = pgTable("poll_auto_responses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id").notNull(),
  pollName: text("poll_name").notNull(),
  optionName: text("option_name").notNull(),
  responseContent: text("response_content").notNull(),
  templateId: integer("template_id"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const aiConfigs = pgTable("ai_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ollamaUrl: varchar("ollama_url", { length: 255 }).default("http://localhost:11434"),
  model: varchar("model", { length: 100 }).default("llama3.2:3b"),
  systemPrompt: text("system_prompt").default("You are a helpful business assistant. Respond professionally and concisely to customer inquiries."),
  businessData: text("business_data").default(""),
  temperature: varchar("temperature", { length: 10 }).default("0.7"),
  maxTokens: integer("max_tokens").default(500),
  isActive: boolean("is_active").default(false).notNull(),
  universalAiReply: boolean("universal_ai_reply").default(false).notNull(),
  language: varchar("language", { length: 20 }).default("en").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const aiMessageQueue = pgTable("ai_message_queue", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id").notNull(),
  phone: varchar("phone", { length: 50 }).notNull(),
  incomingMessage: text("incoming_message").notNull(),
  aiResponse: text("ai_response"),
  status: queueStatusEnum("status").default("queued").notNull(),
  retryCount: integer("retry_count").default(0),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const automationRules = pgTable("automation_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: integer("session_id"),
  name: varchar("name", { length: 255 }).notNull(),
  triggerType: triggerTypeEnum("trigger_type").default("contains").notNull(),
  triggerValue: varchar("trigger_value", { length: 500 }).notNull(),
  actionType: varchar("action_type", { length: 50 }).default("reply").notNull(),
  responseContent: text("response_content").notNull(),
  emailSubject: varchar("email_subject", { length: 255 }),
  emailBody: text("email_body"),
  emailTo: varchar("email_to", { length: 320 }),
  saveContact: boolean("save_contact").default(false),
  isActive: boolean("is_active").default(true).notNull(),
  priority: integer("priority").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// ===== Social Media Automation =====
export const socialAccounts = pgTable("social_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  platform: varchar("platform", { length: 20 }).notNull(), // facebook, instagram
  accountName: varchar("account_name", { length: 255 }),
  pageId: varchar("page_id", { length: 255 }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry"),
  profilePicture: text("profile_picture"),
  isActive: boolean("is_active").default(true).notNull(),
  connectedAt: timestamp("connected_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const socialAutomations = pgTable("social_automations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  accountId: integer("account_id").notNull(),
  platform: varchar("platform", { length: 20 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  triggerType: triggerTypeEnum("trigger_type").default("contains").notNull(),
  triggerValue: varchar("trigger_value", { length: 500 }).notNull(),
  responseType: responseTypeEnum("response_type").default("static").notNull(),
  responseContent: text("response_content").notNull(),
  aiPrompt: text("ai_prompt"),
  isActive: boolean("is_active").default(true).notNull(),
  usageCount: integer("usage_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// ===== Lead URL Forms =====
export const leadUrls = pgTable("lead_urls", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  labels: text("labels").notNull(), // JSON array of field names
  apiKey: varchar("api_key", { length: 255 }).notNull().unique(),
  isActive: boolean("is_active").default(true).notNull(),
  submitCount: integer("submit_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// Service-specific credit packages (admin configurable)
export const servicePackages = pgTable("service_packages", {
  id: serial("id").primaryKey(),
  serviceKey: varchar("service_key", { length: 50 }).notNull(),
  serviceName: varchar("service_name", { length: 100 }).notNull(),
  credits: integer("credits").notNull(),
  price: integer("price").notNull(),
  currency: varchar("currency", { length: 10 }).default("INR"),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Landing page enquiries (simple contact form)
export const landingEnquiries = pgTable("landing_enquiries", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  enterpriseName: varchar("enterprise_name", { length: 255 }),
  phone: varchar("phone", { length: 50 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  message: text("message"),
  status: varchar("status", { length: 20 }).default("new").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ===== Enterprise Plan Enquiries =====
export const enterpriseEnquiries = pgTable("enterprise_enquiries", {
  id: serial("id").primaryKey(),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  employeeCount: varchar("employee_count", { length: 50 }).notNull(),
  businessType: varchar("business_type", { length: 100 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  phone: varchar("phone", { length: 50 }).notNull(),
  countryCode: varchar("country_code", { length: 10 }).default("+1"),
  emailVerified: boolean("email_verified").default(false).notNull(),
  emailOtp: varchar("email_otp", { length: 6 }),
  requirements: text("requirements"),
  status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, contacted, approved, rejected
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});
// ===== YouTube Automation =====
export const youtubeConnections = pgTable("youtube_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  channelId: varchar("channel_id", { length: 100 }),
  channelTitle: varchar("channel_title", { length: 255 }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry"),
  isActive: boolean("is_active").default(false).notNull(),
  lastFetchAt: timestamp("last_fetch_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const youtubeReplyRules = pgTable("youtube_reply_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  triggerType: triggerTypeEnum("trigger_type").default("contains").notNull(),
  triggerValue: varchar("trigger_value", { length: 500 }).notNull(),
  responseContent: text("response_content").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  usageCount: integer("usage_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const youtubeRepliedComments = pgTable("youtube_replied_comments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  videoId: varchar("video_id", { length: 50 }).notNull(),
  commentId: varchar("comment_id", { length: 100 }).notNull().unique(),
  commentText: text("comment_text"),
  replyText: text("reply_text"),
  ruleId: integer("rule_id"),
  repliedAt: timestamp("replied_at").defaultNow().notNull(),
});

// ===== Instagram Automation =====
export const instagramConnections = pgTable("instagram_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  instagramId: varchar("instagram_id", { length: 100 }),
  instagramUsername: varchar("instagram_username", { length: 255 }),
  pageId: varchar("page_id", { length: 100 }),
  pageName: varchar("page_name", { length: 255 }),
  pageAccessToken: text("page_access_token"),
  accessToken: text("access_token"),
  tokenExpiry: timestamp("token_expiry"),
  isActive: boolean("is_active").default(false).notNull(),
  lastFetchAt: timestamp("last_fetch_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const instagramReplyRules = pgTable("instagram_reply_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  triggerType: triggerTypeEnum("trigger_type").default("contains").notNull(),
  triggerValue: varchar("trigger_value", { length: 500 }).notNull(),
  responseContent: text("response_content").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  usageCount: integer("usage_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const instagramRepliedComments = pgTable("instagram_replied_comments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  mediaId: varchar("media_id", { length: 100 }).notNull(),
  commentId: varchar("comment_id", { length: 100 }).notNull().unique(),
  commentText: text("comment_text"),
  replyText: text("reply_text"),
  ruleId: integer("rule_id"),
  repliedAt: timestamp("replied_at").defaultNow().notNull(),
});

export const instagramDmConversations = pgTable("instagram_dm_conversations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  instagramUserId: varchar("instagram_user_id", { length: 100 }).notNull(),
  instagramUsername: varchar("instagram_username", { length: 255 }),
  lastMessageAt: timestamp("last_message_at"),
  unreadCount: integer("unread_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const instagramDmMessages = pgTable("instagram_dm_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  conversationId: integer("conversation_id").notNull(),
  instagramUserId: varchar("instagram_user_id", { length: 100 }).notNull(),
  direction: varchar("direction", { length: 10 }).notNull(), // inbound, outbound
  messageText: text("message_text"),
  metaMessageId: varchar("meta_message_id", { length: 100 }),
  isAutoReply: boolean("is_auto_reply").default(false),
  ruleId: integer("rule_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ===== Email Automation =====
export const emailConfigs = pgTable("email_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  smtpHost: varchar("smtp_host", { length: 255 }).notNull(),
  smtpPort: integer("smtp_port").default(587).notNull(),
  smtpSecure: boolean("smtp_secure").default(false).notNull(),
  imapHost: varchar("imap_host", { length: 255 }),
  imapPort: integer("imap_port").default(993),
  imapSecure: boolean("imap_secure").default(true),
  emailUser: varchar("email_user", { length: 320 }).notNull(),
  emailPass: varchar("email_pass", { length: 255 }).notNull(),
  fromName: varchar("from_name", { length: 255 }),
  fromEmail: varchar("from_email", { length: 320 }),
  isActive: boolean("is_active").default(true).notNull(),
  lastFetchAt: timestamp("last_fetch_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const emailTemplates = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  content: text("content").notNull(),
  isHtml: boolean("is_html").default(true).notNull(),
  variables: text("variables"),
  attachments: text("attachments"), // JSON array of {filename, path}
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const emailMessages = pgTable("email_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  templateId: integer("template_id"),
  direction: varchar("direction", { length: 10 }).notNull(), // inbound, outbound
  fromEmail: varchar("from_email", { length: 320 }).notNull(),
  toEmail: varchar("to_email", { length: 320 }).notNull(),
  subject: varchar("subject", { length: 500 }),
  body: text("body"),
  bodyText: text("body_text"),
  attachments: text("attachments"), // JSON array of {filename, path, size}
  status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, sent, delivered, failed, bounced
  errorMessage: text("error_message"),
  contactId: integer("contact_id"),
  leadId: integer("lead_id"),
  messageId: varchar("message_id", { length: 255 }),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const emailAutomationRules = pgTable("email_automation_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  triggerType: varchar("trigger_type", { length: 50 }).default("contains").notNull(), // contains, exact, from_domain, all
  triggerValue: varchar("trigger_value", { length: 500 }).notNull(),
  responseType: varchar("response_type", { length: 50 }).default("static").notNull(), // static, ai, template
  responseContent: text("response_content").notNull(),
  templateId: integer("template_id"),
  aiPrompt: text("ai_prompt"),
  isActive: boolean("is_active").default(true).notNull(),
  usageCount: integer("usage_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// ===== Meta WhatsApp Business API =====
export const metaWhatsappAccounts = pgTable("meta_whatsapp_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  appId: varchar("app_id", { length: 100 }),
  appSecret: varchar("app_secret", { length: 255 }),
  accessToken: text("access_token"),
  phoneNumberId: varchar("phone_number_id", { length: 100 }),
  wabaId: varchar("waba_id", { length: 100 }),
  displayPhoneNumber: varchar("display_phone_number", { length: 50 }),
  accountName: varchar("account_name", { length: 255 }),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  webhookVerifyToken: varchar("webhook_verify_token", { length: 255 }),
  lastValidatedAt: timestamp("last_validated_at"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const whatsappApiTemplates = pgTable("whatsapp_api_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  accountId: integer("account_id").notNull(),
  templateName: varchar("template_name", { length: 255 }).notNull(),
  language: varchar("language", { length: 10 }).default("en").notNull(),
  category: varchar("category", { length: 20 }).default("UTILITY").notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  components: text("components"),
  metaTemplateId: varchar("meta_template_id", { length: 100 }),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const whatsappApiMessages = pgTable("whatsapp_api_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  accountId: integer("account_id").notNull(),
  phone: varchar("phone", { length: 50 }).notNull(),
  direction: varchar("direction", { length: 10 }).default("outbound").notNull(),
  type: varchar("type", { length: 20 }).default("text").notNull(),
  content: text("content"),
  mediaUrl: text("media_url"),
  templateName: varchar("template_name", { length: 255 }),
  status: varchar("status", { length: 20 }).default("sent").notNull(),
  metaMessageId: varchar("meta_message_id", { length: 100 }),
  conversationId: varchar("conversation_id", { length: 100 }),
  conversationCategory: varchar("conversation_category", { length: 20 }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  sentAt: timestamp("sent_at"),
});

// ===== WhatsApp Session Questionnaires =====
export const sessionQuestionnaires = pgTable("session_questionnaires", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const sessionQuestionnaireQuestions = pgTable("session_questionnaire_questions", {
  id: serial("id").primaryKey(),
  questionnaireId: integer("questionnaire_id").notNull(),
  questionText: varchar("question_text", { length: 500 }).notNull(),
  questionType: varchar("question_type", { length: 20 }).default("text").notNull(), // text, select, yesno
  options: text("options"), // JSON array for select type
  sortOrder: integer("sort_order").default(0),
  isRequired: boolean("is_required").default(true).notNull(),
  mapToLeadField: varchar("map_to_lead_field", { length: 50 }), // name, phone, email, status, tags, notes, data
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessionQuestionnaireAnswers = pgTable("session_questionnaire_answers", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  questionnaireId: integer("questionnaire_id").notNull(),
  questionId: integer("question_id").notNull(),
  answer: text("answer").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const scheduledEmails = pgTable("scheduled_emails", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  toEmail: varchar("to_email", { length: 320 }).notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  body: text("body").notNull(),
  isHtml: boolean("is_html").default(true).notNull(),
  attachments: text("attachments"), // JSON array
  templateId: integer("template_id"),
  contactId: integer("contact_id"),
  scheduledAt: timestamp("scheduled_at").notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, processing, sent, failed
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ===== Monthly Subscription Plans =====
export const subscriptionPlans = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  description: text("description"),
  price: integer("price").notNull(), // in rupees
  currency: varchar("currency", { length: 10 }).default("INR").notNull(),
  periodDays: integer("period_days").default(30).notNull(), // e.g. 30 days
  includedServices: text("included_services").notNull(), // JSON array of serviceKey strings
  maxSessions: integer("max_sessions").default(1),
  maxContacts: integer("max_contacts").default(1000),
  maxTemplates: integer("max_templates").default(50),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// ===== User Subscriptions =====
export const feedbacks = pgTable("feedbacks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  message: text("message").notNull(),
  rating: integer("rating").default(5),
  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const userSubscriptions = pgTable("user_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  planId: integer("plan_id").notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(), // active, expired, cancelled
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  razorpayOrderId: varchar("razorpay_order_id", { length: 255 }),
  razorpayPaymentId: varchar("razorpay_payment_id", { length: 255 }),
  amountPaid: integer("amount_paid").default(0),
  invoiceId: integer("invoice_id"),
  autoRenew: boolean("auto_renew").default(false),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

