/**
 * Cloudflare Workers Environment bindings and configuration
 */

export interface CloudflareEnv {
  /**
   * D1 Database binding
   */
  DB: D1Database;

  /**
   * KV namespace for caching
   */
  CACHE: KVNamespace;

  /**
   * R2 bucket for file storage
   */
  FILES: R2Bucket;

  /**
   * AI Gateway for API calls
   */
  AI_GATEWAY: Fetcher;

  /**
   * Environment variables
   */
  ENVIRONMENT: 'development' | 'staging' | 'production';
  API_URL: string;
  FRONTEND_URL: string;
  WISE_API_KEY: string;
  GEMINI_API_KEY: string;
  OPENAI_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  JWT_SECRET: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  ENABLE_AGENT_CACHING: string;
  MAX_REQUEST_SIZE: string;
  REQUEST_TIMEOUT_MS: string;
  CORS_ORIGIN: string;
  SENTRY_DSN?: string;
}

/**
 * D1 Database type from Cloudflare
 */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(queries: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta: {
    duration: number;
    last_row_id?: number;
    changes?: number;
    served_by?: string;
    internal_stats?: string;
  };
}

export interface D1ExecResult {
  success: boolean;
  count: number;
  duration: number;
}

/**
 * KV Namespace type from Cloudflare
 */
export interface KVNamespace {
  get(key: string, options?: KVGetOptions): Promise<string | null>;
  getWithMetadata<T = unknown>(
    key: string,
    options?: KVGetOptions
  ): Promise<{
    value: string | null;
    metadata: T | null;
  }>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream<Uint8Array>,
    options?: KVPutOptions
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVListOptions): Promise<KVListResult>;
}

export interface KVGetOptions {
  cacheTtl?: number;
  type?: 'text' | 'json' | 'arrayBuffer' | 'stream';
}

export interface KVPutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: unknown;
}

export interface KVListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
}

export interface KVListResult {
  keys: Array<{
    name: string;
    expiration?: number;
    metadata?: unknown;
  }>;
  list_complete: boolean;
  cursor?: string;
}

/**
 * R2 Bucket type from Cloudflare
 */
export interface R2Bucket {
  head(key: string): Promise<R2ObjectMetadata | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | string,
    options?: R2PutOptions
  ): Promise<R2ObjectMetadata>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2ListResult>;
}

export interface R2ObjectMetadata {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  range?: R2Range;
}

export interface R2ObjectBody extends R2ObjectMetadata {
  body: ReadableStream<Uint8Array>;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2Range {
  offset: number;
  length: number;
}

export interface R2GetOptions {
  range?: {
    offset: number;
    length: number;
  };
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2ListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
}

export interface R2ListResult {
  objects: R2ObjectMetadata[];
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}

/**
 * Fetcher type for AI Gateway
 */
export interface Fetcher {
  fetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response>;
}

/**
 * Request context type
 */
export interface RequestContext {
  env: CloudflareEnv;
  ctx: ExecutionContext;
  req: Request;
}

/**
 * ExecutionContext type
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
