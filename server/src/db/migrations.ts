import type Database from 'better-sqlite3';
import { initializeSchema } from './schema.js';
import { logger } from '../services/logger.js';

const migrations: Record<number, (db: Database.Database) => void> = {
  1: (db) => {
    initializeSchema(db);
  },
  2: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_runs (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, channel TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
        items_found INTEGER DEFAULT 0, items_saved INTEGER DEFAULT 0, error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL,
        captured_at TEXT NOT NULL, stars INTEGER DEFAULT 0, forks INTEGER DEFAULT 0,
        open_issues INTEGER DEFAULT 0, subscribers INTEGER DEFAULT 0,
        latest_release_at TEXT, ranking INTEGER, source_channel TEXT NOT NULL,
        UNIQUE(repo_id, captured_at, source_channel)
      );
      CREATE TABLE IF NOT EXISTS project_scores (
        repo_id INTEGER PRIMARY KEY, trending_score REAL DEFAULT 0,
        utility_score REAL DEFAULT 0, final_score REAL DEFAULT 0,
        score_details TEXT, calculated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_digests (
        id TEXT PRIMARY KEY, digest_date TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        summary TEXT, generated_at TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_digest_items (
        digest_id TEXT NOT NULL, repo_id INTEGER NOT NULL, section TEXT NOT NULL,
        ranking INTEGER NOT NULL, reason TEXT, score REAL,
        PRIMARY KEY (digest_id, repo_id)
      );
    `);
    const repoColumns = db.prepare('PRAGMA table_info(repositories)').all() as Array<{ name: string }>;
    const additions: Array<[string, string]> = [
      ['hot_summary_zh', 'TEXT'], ['hot_summary_zh_generated_at', 'TEXT'],
      ['hot_summary_zh_model', 'TEXT'], ['hot_summary_zh_status', "TEXT DEFAULT 'pending'"],
      ['hot_summary_zh_source_hash', 'TEXT'], ['hot_summary_zh_source', 'TEXT'],
    ];
    for (const [column, definition] of additions) {
      if (!repoColumns.some((item) => item.name === column)) db.exec(`ALTER TABLE repositories ADD COLUMN ${column} ${definition}`);
    }
  },
  3: (db) => {
    const columns = db.prepare('PRAGMA table_info(repositories)').all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === 'forks_count')) {
      db.exec('ALTER TABLE repositories ADD COLUMN forks_count INTEGER DEFAULT 0');
    }
  },
  4: (db) => {
    const additions: Array<[string, string]> = [
      ['primary_category', 'TEXT'], ['secondary_categories', 'TEXT'], ['function_tags', 'TEXT'],
      ['product_forms', 'TEXT'], ['platform_tags', 'TEXT'], ['target_users', 'TEXT'],
      ['deployment_modes', 'TEXT'], ['deployment_difficulty', 'TEXT'], ['hot_reason_tags', 'TEXT'],
      ['maturity_tag', 'TEXT'], ['cost_tags', 'TEXT'], ['license_tag', 'TEXT'],
      ['commercial_use_tags', 'TEXT'], ['privacy_tags', 'TEXT'], ['classification_confidence', 'REAL'],
      ['classification_reason', 'TEXT'], ['classification_source', 'TEXT'],
      ['classification_locked', 'INTEGER DEFAULT 0'], ['classification_source_hash', 'TEXT'], ['classified_at', 'TEXT'],
    ];
    const columns = db.prepare('PRAGMA table_info(repositories)').all() as Array<{ name: string }>;
    for (const [column, definition] of additions) {
      if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE repositories ADD COLUMN ${column} ${definition}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_tags (
      id TEXT PRIMARY KEY, dimension TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      parent_id TEXT, aliases TEXT, sort_order INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(dimension, name)
    )`);
    const insert = db.prepare('INSERT OR IGNORE INTO taxonomy_tags (id,dimension,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)');
    const now = new Date().toISOString();
    ['AI 与 Agent', '开发者工具', '数据与数据库', '基础设施与 DevOps', '效率与自动化', '设计与内容创作', '安全与隐私', '桌面与移动应用', '商业与金融', '学习与研究', '其他 / 待分类'].forEach((name, index) => insert.run(`primary-${index}`, 'primary_category', name, index, now, now));
  },
  5: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS classic_project_scores (
      repo_id INTEGER PRIMARY KEY, adoption_score REAL NOT NULL, longevity_score REAL NOT NULL,
      ecosystem_score REAL NOT NULL, community_score REAL NOT NULL, engineering_score REAL NOT NULL,
      current_hot_score REAL NOT NULL, classic_score REAL NOT NULL, hot_score REAL NOT NULL,
      risk_penalty REAL NOT NULL, classic_hot_score REAL NOT NULL, score_confidence REAL NOT NULL,
      score_details_json TEXT NOT NULL, risk_details_json TEXT, ranking_version TEXT NOT NULL, calculated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classic_top100_snapshots (
      snapshot_date TEXT NOT NULL, rank INTEGER NOT NULL, repo_id INTEGER NOT NULL,
      classic_hot_score REAL NOT NULL, rank_change INTEGER, primary_category TEXT NOT NULL,
      ranking_version TEXT NOT NULL, generated_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_date, rank), UNIQUE(snapshot_date, repo_id)
    );`);
  },
  6: (db) => {
    db.prepare("UPDATE repositories SET primary_category='其他 / 待分类', classification_source_hash=NULL WHERE primary_category='商业与金融' AND classification_locked=0").run();
    db.prepare("UPDATE taxonomy_tags SET enabled=0,updated_at=? WHERE dimension='primary_category' AND name='商业与金融'").run(new Date().toISOString());
  },
};

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version table exists first
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersionRow = db
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null } | undefined;

  const currentVersion = currentVersionRow?.version ?? 0;
  const targetVersion = Math.max(...Object.keys(migrations).map(Number));

  if (currentVersion >= targetVersion) {
    return;
  }

  const applyMigration = db.transaction(() => {
    for (let v = currentVersion + 1; v <= targetVersion; v++) {
      const migration = migrations[v];
      if (migration) {
        logger.info('db.migration', `Applying migration v${v}...`);
        migration(db);
        db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(v);
        logger.info('db.migration', `Migration v${v} applied.`);
      }
    }
  });

  applyMigration();
}
