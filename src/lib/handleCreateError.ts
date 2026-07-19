import { ValidationError, DatabaseError } from 'sequelize';
import type { Response } from 'express';

export function handleCreateError(res: Response, err: unknown, fallbackMessage: string) {
  if (err instanceof ValidationError) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: err.errors.map((e) => ({ field: e.path, message: e.message })),
    });
  }
  if (err instanceof DatabaseError) {
    const code = (err.original as { code?: string; sqlMessage?: string })?.code;
    if (code === 'ER_DATA_TOO_LONG') {
      const match = /Data too long for column '(\w+)'/.exec(
        (err.original as { sqlMessage?: string })?.sqlMessage ?? ''
      );
      return res.status(400).json({
        success: false,
        error: match ? `Value too long for field "${match[1]}"` : 'One of the submitted fields is too long',
      });
    }
  }
  res.status(500).json({ success: false, error: fallbackMessage });
}
