/**
 * Nexus Financial Platform - Shared Package
 * Core types, engines, and configuration for the entire platform
 *
 * This package contains:
 * - Type definitions (API, models, agents, environment)
 * - Business logic engines (forecast, tax, FX, scoring, simulation)
 * - Configuration management (loads from D1 database)
 *
 * No hardcoded values - all thresholds and parameters are configuration-driven
 */

// Export all types (already has explicit exports to avoid duplicates)
export * from './types';

// Export all engines (already has explicit exports to avoid duplicates)
export * from './engines';

// Export configuration
export {
  loadConfig,
  getConfigValue,
  setConfigValue,
  seedDefaultConfig,
  DEFAULT_CONFIG,
  type AppConfiguration,
  type AppSettings,
} from './config';

// Version
export const VERSION = '1.0.0';
export const PACKAGE_NAME = '@nexus/shared';
