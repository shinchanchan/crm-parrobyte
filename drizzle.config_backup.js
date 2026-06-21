/** @type {import("drizzle-kit").Config} */
export default {
  schema: "./db/schema.js",
  out: "./db/migrations",
	dialect: "postgresql",
  dbCredentials: {
    connectionString: "postgresql://vallarasu:ShinChan66@localhost:5432/whatscrm",
  },
};
