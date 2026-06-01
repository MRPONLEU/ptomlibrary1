import express from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { Pool } from "pg";
import dotenv from "dotenv";
import dns from "dns";

dns.setDefaultResultOrder("ipv4first");
dotenv.config();

const rawConnectionString = process.env.DATABASE_URL;
// Remove any leading/trailing spaces or surrounding quotes pasted accidentally
const connectionString = rawConnectionString ? rawConnectionString.trim().replace(/^["']|["']$/g, "") : undefined;
let pool: Pool | null = null;
let dbInitError: string | null = null;

let parsedHost = "unknown";
let parsedPort = "unknown";
let parsedDbName = "unknown";

try {
  if (connectionString) {
    const url = new URL(connectionString.startsWith('postgres') ? connectionString : `postgres://${connectionString}`);
    parsedHost = url.hostname;
    parsedPort = url.port || "5432";
    parsedDbName = url.pathname.replace(/^\//, "");
  }
} catch (e) {
  parsedHost = "custom-connection-string";
}

// Global state to track if schema creation was checked and run
let tablesInitialized = false;
let dbSetupPromise: Promise<void> | null = null;

/**
 * Lazy initialization of the database pool and tables.
 * This is extremely important in serverless runtimes (like Vercel)
 * because it avoids blocking the startup sequence and prevents timeouts.
 */
async function getPool(): Promise<Pool> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured inside the environment/Secrets.");
  }

  if (!pool) {
    console.log(`[Database] Initializing connection pool to host: ${parsedHost}, port: ${parsedPort}, database: ${parsedDbName}`);
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 5, // Optimal conservative limit to avoid exhausting connection pools in serverless instances
      idleTimeoutMillis: 15000, // Speed up release of connection resources
      connectionTimeoutMillis: 5000, // Don't hang indefinitely if blocked by private network rules
    });
  }

  if (!tablesInitialized) {
    if (!dbSetupPromise) {
      dbSetupPromise = (async () => {
        try {
          console.log("[Database] Checking and auto-initializing necessary tables...");
          await pool!.query(`
            CREATE TABLE IF NOT EXISTS admins (
              id SERIAL PRIMARY KEY,
              email VARCHAR(255) UNIQUE NOT NULL,
              added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS categories (
              id VARCHAR(255) PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              sub_types JSONB DEFAULT '[]'::jsonb
            );

            CREATE TABLE IF NOT EXISTS docs (
              id VARCHAR(255) PRIMARY KEY,
              title VARCHAR(255) NOT NULL,
              description TEXT,
              cover_url TEXT,
              file_size VARCHAR(50),
              file_type VARCHAR(50),
              download_url TEXT,
              upload_date VARCHAR(50),
              downloads INTEGER DEFAULT 0,
              type VARCHAR(255),
              sub_type VARCHAR(255),
              is_hidden BOOLEAN DEFAULT FALSE,
              tags JSONB DEFAULT '[]'::jsonb
            );
          `);

          // Ensure default administrative accounts exist in DB
          const adminCheck = await pool!.query("SELECT * FROM admins WHERE email = 'broponleu998@gmail.com'");
          if (adminCheck.rows.length === 0) {
            await pool!.query("INSERT INTO admins (email) VALUES ('broponleu998@gmail.com')");
            await pool!.query("INSERT INTO admins (email) VALUES ('mrponleu20000@gmail.com')");
          }

          console.log("[Database] Schema checks are fully complete!");
          tablesInitialized = true;
          dbInitError = null;
        } catch (err: any) {
          dbInitError = err.message;
          console.error("[DatabaseError] FAILED to auto-initialize tables schema:", err.message);
          dbSetupPromise = null; // Reset schema promise so we can retry on next request if transient
          throw err;
        }
      })();
    }
    await dbSetupPromise;
  }

  return pool;
}

const app = express();

app.use(cors());
app.use(express.json());

// Try early trigger connection so it doesn't wait entirely for first request
if (connectionString) {
  getPool().catch(err => {
    console.warn("[Database] Ignored early warning on pre-connect. Pool will self-heal on first request:", err.message);
  });
}

// --- API Routes ---
app.get("/api/db-check", async (req, res) => {
  let testError: any = null;
  let testSuccess = false;
  if (connectionString) {
    try {
      console.log("[Database Debug] Manual diagnostics test connecting to pool...");
      const activePool = await getPool();
      const client = await activePool.connect();
      const testRes = await client.query("SELECT 1");
      console.log("[Database Debug] Connection test query SELECT 1 succeeded!", testRes.rows);
      client.release();
      testSuccess = true;
    } catch (err: any) {
      console.error("[Database Debug] Manual test connection failed:", err);
      testError = {
        message: err.message,
        code: err.code,
        stack: err.stack,
        severity: err.severity,
        detail: err.detail,
        hint: err.hint,
      };
    }
  }
  res.json({
    configured: !!connectionString,
    host: parsedHost,
    port: parsedPort,
    database: parsedDbName,
    dbInitError,
    testSuccess,
    testError,
  });
});

app.use("/api", async (req, res, next) => {
  if (!connectionString) {
    return res.status(500).json({ error: "DATABASE_URL environment variable is missing. Please configure your Postgres connection string in the Secrets panel." });
  }
  try {
    // Dynamically ensures the pool and tables are active
    await getPool();
    next();
  } catch (err: any) {
    return res.status(500).json({ error: `Database Connection Failed: ${err.message}. Please double-check your connection string configuration.` });
  }
});

// Auth / Admins
app.get("/api/admins", async (req, res) => {
  try {
    const activePool = await getPool();
    const result = await activePool.query("SELECT * FROM admins ORDER BY added_at ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/admins", async (req, res) => {
  try {
    const { email } = req.body;
    const activePool = await getPool();
    const result = await activePool.query(
      "INSERT INTO admins (email) VALUES ($1) RETURNING *",
      [email.toLowerCase()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/admins/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const activePool = await getPool();
    await activePool.query("DELETE FROM admins WHERE email = $1", [email.toLowerCase()]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Docs
app.get("/api/docs", async (req, res) => {
  try {
    const activePool = await getPool();
    const result = await activePool.query("SELECT * FROM docs");
    // Map back to camelCase properties for frontend
    const docs = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      coverUrl: row.cover_url,
      fileSize: row.file_size,
      fileType: row.file_type,
      downloadUrl: row.download_url,
      uploadDate: row.upload_date,
      downloads: row.downloads,
      type: row.type,
      subType: row.sub_type,
      isHidden: row.is_hidden,
      tags: row.tags
    }));
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/docs", async (req, res) => {
  try {
    const { title, description, coverUrl, fileSize, fileType, downloadUrl, uploadDate, type, subType, isHidden, tags } = req.body;
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const activePool = await getPool();
    const result = await activePool.query(
      `INSERT INTO docs (id, title, description, cover_url, file_size, file_type, download_url, upload_date, type, sub_type, is_hidden, tags) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [id, title, description, coverUrl, fileSize, fileType, downloadUrl, uploadDate, type, subType, isHidden || false, JSON.stringify(tags || [])]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put("/api/docs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, coverUrl, fileSize, fileType, downloadUrl, uploadDate, downloads, type, subType, isHidden, tags } = req.body;
    
    const updateFields: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (title !== undefined) { updateFields.push(`title = $${i++}`); values.push(title); }
    if (description !== undefined) { updateFields.push(`description = $${i++}`); values.push(description); }
    if (coverUrl !== undefined) { updateFields.push(`cover_url = $${i++}`); values.push(coverUrl); }
    if (fileSize !== undefined) { updateFields.push(`file_size = $${i++}`); values.push(fileSize); }
    if (fileType !== undefined) { updateFields.push(`file_type = $${i++}`); values.push(fileType); }
    if (downloadUrl !== undefined) { updateFields.push(`download_url = $${i++}`); values.push(downloadUrl); }
    if (uploadDate !== undefined) { updateFields.push(`upload_date = $${i++}`); values.push(uploadDate); }
    if (downloads !== undefined) { updateFields.push(`downloads = $${i++}`); values.push(downloads); }
    if (type !== undefined) { updateFields.push(`type = $${i++}`); values.push(type); }
    if (subType !== undefined) { updateFields.push(`sub_type = $${i++}`); values.push(subType); }
    if (isHidden !== undefined) { updateFields.push(`is_hidden = $${i++}`); values.push(isHidden); }
    if (tags !== undefined) { updateFields.push(`tags = $${i++}`); values.push(JSON.stringify(tags)); }

    if (updateFields.length > 0) {
      values.push(id);
      const activePool = await getPool();
      const query = `UPDATE docs SET ${updateFields.join(', ')} WHERE id = $${i} RETURNING *`;
      const result = await activePool.query(query, values);
      const row = result.rows[0];
      res.json({
        id: row.id,
        title: row.title,
        description: row.description,
        coverUrl: row.cover_url,
        fileSize: row.file_size,
        fileType: row.file_type,
        downloadUrl: row.download_url,
        uploadDate: row.upload_date,
        downloads: row.downloads,
        type: row.type,
        subType: row.sub_type,
        isHidden: row.is_hidden,
        tags: row.tags
      });
    } else {
      res.json({ message: "Nothing to update" });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/docs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const activePool = await getPool();
    await activePool.query("DELETE FROM docs WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Categories
app.get("/api/categories", async (req, res) => {
  try {
    const activePool = await getPool();
    const result = await activePool.query("SELECT * FROM categories");
    const categories = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      subTypes: row.sub_types
    }));
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/categories", async (req, res) => {
  try {
    const { name, subTypes } = req.body;
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const activePool = await getPool();
    const result = await activePool.query(
      "INSERT INTO categories (id, name, sub_types) VALUES ($1, $2, $3) RETURNING *",
      [id, name, JSON.stringify(subTypes || [])]
    );
    res.json({ id: result.rows[0].id, name: result.rows[0].name, subTypes: result.rows[0].sub_types });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put("/api/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, subTypes } = req.body;
    
    const updateFields: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (name !== undefined) { updateFields.push(`name = $${i++}`); values.push(name); }
    if (subTypes !== undefined) { updateFields.push(`sub_types = $${i++}`); values.push(JSON.stringify(subTypes)); }

    if (updateFields.length > 0) {
      values.push(id);
      const activePool = await getPool();
      const query = `UPDATE categories SET ${updateFields.join(', ')} WHERE id = $${i} RETURNING *`;
      const result = await activePool.query(query, values);
      res.json({ id: result.rows[0].id, name: result.rows[0].name, subTypes: result.rows[0].sub_types });
    } else {
      res.json({ message: "Nothing to update" });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const activePool = await getPool();
    await activePool.query("DELETE FROM categories WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Configure Asset Serving and Dev/Prod Server Lifecycles
 */
const startAppServer = async () => {
  if (process.env.NODE_ENV !== "production") {
    // Local development: mount Vite dev server in middlewareMode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);

    const PORT = 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[LocalDev] Express server running on port ${PORT}`);
    });
  } else {
    // Production lifecycle
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    
    // Fallback index.html router for client-side routing
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });

    // In Vercel, we must NEVER listen to a port manually because the port is automatically
    // bounded by Vercel serverless containers. Doing it anyway crashes the function.
    if (!process.env.VERCEL) {
      const PORT = 3000;
      app.listen(PORT, "0.0.0.0", () => {
        console.log(`[LocalProd] Express server running on port ${PORT}`);
      });
    } else {
      console.log("[VercelDeploy] Server loaded successfully in serverless environment!");
    }
  }
};

startAppServer().catch(err => {
  console.error("Critical error starting application server:", err);
});

// Export default app for Vercel Serverless runtime to hook directly
export default app;
