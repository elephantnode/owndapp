// Ordered as a project moves: planned, built, tested, run, then finished or stopped. Keys predating planning/active/testing/completed/cancelled
// keep their stored values, so existing catalogs need no migration. untriaged is the state right after registration.
export type Lifecycle = 'untriaged' | 'planning' | 'active' | 'testing' | 'maintained' | 'on_hold' | 'completed' | 'cancelled' | 'archived';
export const lifecycleLabels: Record<Lifecycle, string> = {
  untriaged: '未設定', planning: '計画中', active: '開発中', testing: 'テスト・検証', maintained: '運用中', on_hold: '保留',
  completed: '完了', cancelled: '中止', archived: 'アーカイブ',
};
export interface Evidence { file: string; detail: string }
export interface Component { name: string; path: string; technologies: string[] }
export interface Candidate {
  id: string;
  path: string;
  name: string;
  technologies: string[];
  components: Component[];
  evidence: Evidence[];
  fingerprint: string;
  registered: boolean;
  /** Registered projects inside this candidate's folder, such as themes registered before a site was grouped. */
  registeredInside?: number;
  /** The scan stopped at its limit before every folder inside was read. Importing reads it again in full and registers that. */
  incomplete?: boolean;
}
export interface Project extends Candidate {
  purpose: string;
  tags: string[];
  notes: string;
  lifecycle: Lifecycle;
  archiveReason: string;
  archivedAt: string | null;
  createdAt: string;
  observedAt: string;
  revision: number;
  importBatch: string;
  /** Where the project runs. Absent means unknown. */
  exposure?: Exposure;
  /** Lifecycle just before archiving, restored when the project leaves the archive. Absent for projects archived before it was recorded. */
  archivedFrom?: Lifecycle;
  /** File the purpose was filled from automatically (README.md, package.json...). Cleared when the purpose is edited. */
  purposeSource?: string;
  /** Checked on every catalog read and never stored: true only when the folder does not exist. */
  missing?: boolean;
  /** Checked on every catalog read and never stored: true when the folder is inside an excluded folder. */
  excluded?: boolean;
  /** From the latest dependency snapshot, added on catalog reads. Absent when dependencies were never read. */
  dependencyStatus?: DependencyStatus;
  dependenciesReadAt?: string;
  /** Number of known dependency files whose format could not be inspected. */
  dependencyUnsupported?: number;
  /** From the latest git observation, added on catalog reads. Absent when git was never read. */
  gitStatus?: GitStatus;
  gitReadAt?: string;
  /** Number of remotes when status is ok. Absent when never read or not ok. */
  gitRemoteCount?: number;
  /** Branch name when status is ok and not detached. */
  gitBranch?: string | null;
  /** True when HEAD was detached at the last read. */
  gitDetached?: boolean;
  /** From the latest vulnerability check, added on catalog reads. Absent when never checked. */
  vulnerabilities?: VulnerabilitySummary;
}
/** A remote from .git/config. url has credentials stripped. */
export interface GitRemote { name: string; url: string }
/** ok: HEAD and config were read. no-git: no .git above the project. unreadable / invalid: could not use what was found. */
export type GitStatus = 'ok' | 'no-git' | 'unreadable' | 'invalid';
/** One on-demand read of the project's enclosing Git repository (branch and remotes only). */
export interface GitObservation {
  projectId: string;
  readAt: string;
  status: GitStatus;
  /** Working tree root that owns .git, relative to the project when inside it, otherwise absolute. */
  gitRoot: string | null;
  /** Branch name from HEAD. null when detached, unborn, or unknown. */
  branch: string | null;
  detached: boolean;
  remotes: GitRemote[];
  message?: string;
}
export type AppRole = 'editor' | 'terminal';
export const appRoleLabels: Record<AppRole, string> = { editor: 'エディタ', terminal: 'ターミナル' };
/** A macOS application registered to open project folders. path is the .app bundle. */
export interface OpenApp { name: string; path: string }
export type OpenApps = Record<AppRole, OpenApp | null>;
/** prod/dev/optional/peer follow the lockfile's flags. They describe the declaration, not what is installed or deployed. */
export type DependencyScope = 'prod' | 'dev' | 'optional' | 'peer' | 'unknown';
/**
 * registry is the public registry of the ecosystem only: registry.npmjs.org (or registry.yarnpkg.com, which serves it), packagist.org, pypi.org.
 * Packages from any other host, even registry-shaped ones such as mirrors or private indexes, are kept apart as other-registry.
 * registry-unrecorded: a plain version with no recorded origin, which the package manager installs from the configured registry
 * (for example pnpm and Yarn 2+ lockfiles, or pinned lines in requirements.txt). Which registry it was is not recorded.
 */
export type DependencySource = 'registry' | 'other-registry' | 'registry-unrecorded' | 'url' | 'git' | 'file' | 'unknown';
/** OSV ecosystem names. npm covers npm, Yarn, and pnpm lockfiles; Packagist is Composer; PyPI is Python. */
export type Ecosystem = 'npm' | 'Packagist' | 'PyPI' | 'crates.io';
export const ecosystemLabels: Record<Ecosystem, string> = { npm: 'npm', Packagist: 'Composer', PyPI: 'Python', 'crates.io': 'Rust' };
export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  /** Resolved version recorded in the lockfile. */
  version: string | null;
  /** Range declared in the manifest, for direct dependencies only. Unpinned requirements.txt lines keep their specifier here. */
  requested: string | null;
  direct: boolean;
  scope: DependencyScope;
  source: DependencySource;
  /** Lockfile path relative to the project folder. */
  file: string;
  /** Folder relative to the project that the dependency belongs to. '' is the project itself or a hoisted dependency. */
  component: string;
}
/** unpinned: a requirements file was read, but some lines name no exact version. */
export type LockFileStatus = 'ok' | 'mismatch' | 'unpinned' | 'no-lock' | 'invalid' | 'unsupported' | 'too-large' | 'unreadable';
export interface LockFileResult {
  /** The lockfile, or the manifest (package.json, composer.json, pyproject.toml, Pipfile) when no lockfile exists, relative to the project folder. */
  path: string;
  /** npm's lockfileVersion. Other formats leave it null and name themselves in format. */
  lockfileVersion: number | null;
  /** The format as shown, such as "npm v3", "Yarn v1", "pnpm 9.0", "Composer", "Poetry 2.1", "uv", "Pipfile.lock", "requirements". Absent in older reads. */
  format?: string;
  status: LockFileStatus;
  message: string;
  /** sha256 of every file read, keyed by path relative to the project folder. */
  hashes: Record<string, string>;
}
/**
 * complete: at least one lock/manifest was read successfully; other locations may lack a lock (shown per file, not as a project failure).
 * partial: some locations had a real read problem (unreadable, invalid, unsupported, too-large).
 * failed: none could be read. no-lock: no supported lockfile exists anywhere.
 */
export type DependencyStatus = 'complete' | 'partial' | 'failed' | 'no-lock';
export interface DependencySnapshot {
  /** Stable identity of file coverage and dependency content; absent in older catalogs. */
  contentId?: string;
  projectId: string;
  readAt: string;
  status: DependencyStatus;
  files: LockFileResult[];
  total: number;
  direct: number;
}
/** Malicious-package records, provider labels and supported CVSS ratings; unknown when no usable rating exists. */
export type Severity = 'malicious' | 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  severitySource: string | null;
  severityScore?: number | null;
  severityReason?: string;
  severityConflict?: boolean;
  severityRetained?: boolean;
  severityEvidence?: { id: string; severity: Severity; source: string; score?: number | null; cvss?: string | null }[];
  /** Published CVSS vector or numeric score. */
  cvss: string | null;
  /** Lowest fixed version for the affected range, from the advisory. null: the advisory names none, not "no fix exists". */
  fixed: string | null;
  published: string | null;
  modified: string | null;
  references: string[];
  /** false when only the id could be fetched. */
  detailsAvailable: boolean;
}
export interface VulnerabilityFinding {
  retained?: boolean;
  observedAt?: string;
  dependency: Dependency;
  advisories: Advisory[];
}
/** complete: every sendable package version and reported advisory detail was answered. partial: queries or details were unavailable. */
export type VulnerabilityCheckStatus = 'complete' | 'partial';
export interface VulnerabilityCheck {
  projectId: string;
  checkedAt: string;
  /** readAt of the checked snapshot; a fallback for older catalogs without content identity. */
  snapshotReadAt: string;
  snapshotContentId?: string;
  status: VulnerabilityCheckStatus;
  /** Distinct package versions sent and answered, and those that failed. */
  queried: number;
  failed: number;
  detailsFailed?: number;
  attemptedAt?: string;
  /** Dependencies not sent, by reason: git / url / file / unknown source, or no resolved version (including unpinned requirements). */
  notSent: Record<string, number>;
  findings: VulnerabilityFinding[];
}
/** Per project summary added on catalog reads. */
export interface VulnerabilitySummary { checkedAt: string; status: VulnerabilityCheckStatus; count: number; highest: Severity | null; stale: boolean }
export interface ScanIssue { path: string; message: string }
export interface Scan {
  /** DB-backed scans keep queues and results outside the summary payload. */
  persistent?: boolean;
  phase?: 'traverse' | 'group' | 'done';
  canResume?: boolean;
  canRetry?: boolean;
  candidateCount?: number;
  filteredCount?: number;
  processedFolders?: number;
  errorCount?: number;
  issueCount?: number;
  id: string;
  root: string;
  status: 'running' | 'paused' | 'completed' | 'partial' | 'cancelled' | 'failed';
  startedAt: string;
  endedAt: string | null;
  visited: number;
  excluded: number;
  candidates: Candidate[];
  issues: ScanIssue[];
  currentPath: string;
  /** Excluded folders applied to this scan. Older scans have none recorded. */
  exclusions?: string[];
  /** Progress while running: folders with project files found so far (before grouping), and folders still waiting to be read. */
  found?: number;
  pending?: number;
  /** The limits that stop the scan, for showing how far it may still go. */
  limits?: { entries: number; milliseconds: number };
}
export interface ProjectEdit {
  revision: number;
  name: string;
  purpose: string;
  tags: string[];
  notes: string;
  lifecycle: Lifecycle;
  archiveReason: string;
  /** Optional so older clients keep the stored value. */
  exposure?: Exposure;
}

/** Where a project runs. unknown is never treated as low risk. */
export type Exposure = 'public' | 'internal' | 'local' | 'unknown';
export const exposureLabels: Record<Exposure, string> = { public: '公開', internal: '社内', local: 'ローカルのみ', unknown: '不明' };

/**
 * How a known vulnerability in a project is being handled. resolved is set only by a later check that no longer finds it;
 * a check that finds it again reopens it. not-applicable needs a reason.
 */
export type ResponseStatus = 'open' | 'investigating' | 'fixing' | 'awaiting-recheck' | 'not-applicable' | 'resolved';
export const responseLabels: Record<ResponseStatus, string> = {
  open: '未対応', investigating: '調査中', fixing: '対応中', 'awaiting-recheck': '再照会待ち', 'not-applicable': '対象外', resolved: '解消確認',
};
export type Priority = 'high' | 'review' | 'medium' | 'low';
export const priorityLabels: Record<Priority, string> = { high: '高', review: '要確認', medium: '中', low: '低' };
export interface ResponseEvent { at: string; status: ResponseStatus; note?: string; by: 'user' | 'recheck' }
export interface ResponseRecord {
  projectId: string;
  advisoryId: string;
  status: ResponseStatus;
  note: string;
  /** Date to look at a not-applicable decision again (YYYY-MM-DD). */
  reviewBy: string | null;
  updatedAt: string;
  resolvedAt: string | null;
  /** What the advisory was when last seen, so resolved items stay readable after the finding is gone. */
  advisory: Pick<Advisory, 'id' | 'summary' | 'severity' | 'fixed'> & { package: string; version: string | null; ecosystem?: Ecosystem };
  history: ResponseEvent[];
}
/** One known vulnerability in one project, with how it is being handled. */
export interface QueueItem {
  projectId: string;
  advisory: Advisory;
  dependencies: Dependency[];
  status: ResponseStatus;
  note: string;
  reviewBy: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
  priority: Priority;
  priorityReason?: string;
  needsReview?: boolean;
  retained?: boolean;
  advisoryVariants?: { dependency: Dependency; advisory: Advisory }[];
}

/** Features offered by the server OS, never inferred from the browser OS. */
export interface PlatformCapabilities {
  platform: string;
  folderPicker: boolean;
  revealFolder: boolean;
  externalApps: boolean;
}
