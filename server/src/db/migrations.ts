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
  7: (db) => {
    // Existing databases passed the initial schema migration before these
    // enrichment cache fields were introduced.
    const columns = db.prepare('PRAGMA table_info(repositories)').all() as Array<{ name: string }>;
    const add = (name: string, definition: string) => {
      if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE repositories ADD COLUMN ${name} ${definition}`);
    };
add('enrichment_readme', 'TEXT');
    add('enrichment_architecture', 'TEXT');
    add('enrichment_updated_at', 'TEXT');
  },
  8: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fork_workspace_projects (
        id TEXT PRIMARY KEY,
        repo_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        upstream_full_name TEXT NOT NULL,
        fork_full_name TEXT,
        fork_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
        upstream_commit_sha TEXT,
        test_branch TEXT,
        project_status TEXT NOT NULL DEFAULT 'SELECTED',
        selected_at TEXT NOT NULL,
        forked_at TEXT,
        archived_at TEXT,
        UNIQUE(repo_id)
      );
      CREATE TABLE IF NOT EXISTS deployment_assessments (
        repo_id INTEGER PRIMARY KEY,
        value_score REAL NOT NULL,
        difficulty_score REAL NOT NULL,
        testability_score REAL NOT NULL,
        risk_score REAL NOT NULL,
        recommended_level TEXT NOT NULL,
        recommended_strategy TEXT,
        assessment_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        ai_config_id TEXT,
        confidence REAL,
        assessed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployment_plans (
        id TEXT PRIMARY KEY,
        workspace_project_id TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        plan_source TEXT NOT NULL,
        plan_version INTEGER NOT NULL DEFAULT 1,
        locked INTEGER NOT NULL DEFAULT 0,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
  9: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_batches (
        id TEXT PRIMARY KEY,
        name TEXT,
        agent_id TEXT,
        runner_id TEXT,
        test_level TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS deployment_tasks (
        id TEXT PRIMARY KEY,
        batch_id TEXT,
        workspace_project_id TEXT NOT NULL,
        runner_id TEXT,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT,
        progress REAL DEFAULT 0,
        max_repair_iterations INTEGER DEFAULT 3,
        allow_modification INTEGER DEFAULT 1,
        allow_commit INTEGER DEFAULT 1,
        allow_push INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS deployment_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        plan_json TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        result_json TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS local_deployments (
        id TEXT PRIMARY KEY,
        workspace_project_id TEXT NOT NULL,
        task_id TEXT,
        runner_id TEXT NOT NULL,
        workspace_path TEXT,
        container_names_json TEXT,
        image_names_json TEXT,
        ports_json TEXT,
        status TEXT NOT NULL,
        disk_usage_bytes INTEGER,
        started_at TEXT,
        stopped_at TEXT,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runner_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        last_heartbeat_at TEXT,
        registered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployment_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        runner_id TEXT,
        event_type TEXT NOT NULL,
        stage TEXT,
        message TEXT,
        created_at TEXT NOT NULL
      );
    `);
  },
  10: (db) => {
    // v9 allowed projects to be removed while their task records remained.
    // Remove those orphaned records before task views dereference the project.
    db.exec(`
      DELETE FROM deployment_task_events
      WHERE task_id IN (
        SELECT t.id FROM deployment_tasks t
        LEFT JOIN fork_workspace_projects p ON p.id=t.workspace_project_id
        WHERE p.id IS NULL
      );
      DELETE FROM deployment_runs
      WHERE task_id IN (
        SELECT t.id FROM deployment_tasks t
        LEFT JOIN fork_workspace_projects p ON p.id=t.workspace_project_id
        WHERE p.id IS NULL
      );
      DELETE FROM local_deployments
      WHERE workspace_project_id NOT IN (SELECT id FROM fork_workspace_projects);
      DELETE FROM deployment_tasks
      WHERE workspace_project_id NOT IN (SELECT id FROM fork_workspace_projects);
    `);
  },
  11: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_test_reports (
        id TEXT PRIMARY KEY,
        workspace_project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        runner_id TEXT,
        status TEXT NOT NULL,
        report_markdown TEXT NOT NULL,
        result_json TEXT,
        logs_text TEXT,
        workspace_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_test_reports_project_created
        ON project_test_reports(workspace_project_id, created_at DESC);
    `);
  },
  12: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_test_reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        workspace_project_id TEXT NOT NULL,
        report_status TEXT NOT NULL,
        deployment_value TEXT,
        confidence TEXT,
        user_report_json TEXT,
        user_report_markdown TEXT,
        claim_validation_json TEXT,
        generated_at TEXT,
        finalized_at TEXT
      );
      CREATE TABLE IF NOT EXISTS local_test_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size_bytes INTEGER,
        checksum TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS local_test_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        category TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_local_test_artifacts_task ON local_test_artifacts(task_id);
    `);
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
