/**
 * Validation utilities using Zod
 */

import { z } from 'zod';
import { ValidationError } from './errors';

export const emailSchema = z.string().email('Invalid email address');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const userSchema = z.object({
  email: emailSchema,
  name: z.string().min(2, 'Name must be at least 2 characters'),
  timezone: z.string().default('UTC'),
  currency: z.string().default('USD'),
  country: z.string().optional(),
  businessType: z.string().optional(),
  vatNumber: z.string().optional(),
});

export const invoiceSchema = z.object({
  invoiceNumber: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  issueDate: z.string().datetime(),
  dueDate: z.string().datetime(),
  amount: z.number().positive(),
  currency: z.string(),
  tax: z.number().nonnegative(),
  status: z.enum(['draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled']),
  description: z.string().optional(),
  notes: z.string().optional(),
});

export const expenseSchema = z.object({
  date: z.string().datetime(),
  category: z.string(),
  description: z.string(),
  amount: z.number().positive(),
  currency: z.string(),
  paymentMethod: z.string(),
  tax: z.number().nonnegative(),
  taxRate: z.number().nonnegative(),
  taxable: z.boolean(),
  receipt: z.string().optional(),
  notes: z.string().optional(),
});

export const contractSchema = z.object({
  clientId: z.string(),
  clientName: z.string(),
  title: z.string(),
  hourlyRate: z.number().positive(),
  hoursPerWeek: z.number().positive(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  currency: z.string(),
  status: z.enum(['active', 'paused', 'ended', 'upcoming']),
  renewalDate: z.string().datetime().optional(),
  terms: z.string().optional(),
  notes: z.string().optional(),
});

export const scenarioSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(['revenue', 'expense', 'growth', 'contraction', 'custom']),
  revenueChange: z.number(),
  rateChange: z.number(),
  hoursChange: z.number(),
  expenseIncrease: z.number(),
  startMonth: z.string(),
  duration: z.number().positive(),
});

export const paginationSchema = z.object({
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
  page: z.number().int().positive().optional(),
});

/**
 * Validate data against schema
 */
export function validate<T>(schema: z.ZodSchema, data: unknown): T {
  try {
    return schema.parse(data) as T;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors.reduce(
        (acc, err) => {
          acc[err.path.join('.')] = err.message;
          return acc;
        },
        {} as Record<string, string>
      );
      throw new ValidationError('Validation failed', details);
    }
    throw error;
  }
}

/**
 * Validate optional data
 */
export function validateOptional<T>(schema: z.ZodSchema, data: unknown): T | null {
  if (data === null || data === undefined) {
    return null;
  }
  return validate<T>(schema, data);
}
