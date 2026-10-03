import type { NextFunction, Request, Response } from 'express';
import { body, param, queryParams } from '../../middleware/validate.js';
import * as service from './service.js';
import {
  allergySchema,
  breakGlassSchema,
  createPatientSchema,
  searchPatientsSchema,
  updatePatientSchema,
} from './schemas.js';

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.registerPatient(req, body(req, createPatientSchema));
    res.status(201).json({ data: result.patient, meta: { duplicatesAcknowledged: result.duplicatesAcknowledged } });
  } catch (error) {
    next(error);
  }
}

export async function search(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.searchPatients(req, queryParams(req, searchPatientsSchema));
    res.json({
      data: result.items,
      meta: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getPatient(req, param(req, 'patientId'));
    res.json({
      data: result.patient,
      meta: { clinical: result.clinical, accessBasis: result.accessBasis },
    });
  } catch (error) {
    next(error);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const patient = await service.updatePatient(
      req,
      param(req, 'patientId'),
      body(req, updatePatientSchema),
    );
    res.json({ data: patient });
  } catch (error) {
    next(error);
  }
}

export async function addAllergy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.addAllergy(req, param(req, 'patientId'), body(req, allergySchema));
    res.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function breakGlass(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.grantBreakGlassAccess(req, body(req, breakGlassSchema));
    res.status(201).json({
      data: result,
      meta: {
        notice:
          'This access is logged and will be reviewed by the privacy officer. Use it only where there is a clinical need.',
      },
    });
  } catch (error) {
    next(error);
  }
}
