import type { NextFunction, Request, Response } from 'express';
import { body, param, queryParams } from '../../middleware/validate.js';
import * as service from './service.js';
import {
  availabilitySchema,
  bookAppointmentSchema,
  cancelSchema,
  checkInSchema,
  listAppointmentsSchema,
  rescheduleSchema,
} from './schemas.js';

export async function availability(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const slots = await service.findAvailableSlots(req, queryParams(req, availabilitySchema));

    // Grouped by local date, because that is how a calendar renders it and
    // regrouping 2,000 slots in the browser is wasted work.
    const byDate = slots.reduce<Record<string, service.FreeSlot[]>>((acc, slot) => {
      (acc[slot.localDate] ??= []).push(slot);
      return acc;
    }, {});

    res.json({
      data: byDate,
      meta: { totalSlots: slots.length, days: Object.keys(byDate).length },
    });
  } catch (error) {
    next(error);
  }
}

export async function book(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const appointment = await service.bookAppointment(req, body(req, bookAppointmentSchema));
    res.status(201).json({ data: appointment });
  } catch (error) {
    next(error);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = queryParams(req, listAppointmentsSchema);
    const result = await service.listAppointments(req, query);
    res.json({
      data: result.items,
      meta: {
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.ceil(result.total / query.pageSize),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function reschedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const appointment = await service.rescheduleAppointment(
      req,
      param(req, 'appointmentId'),
      body(req, rescheduleSchema),
    );
    res.json({ data: appointment });
  } catch (error) {
    next(error);
  }
}

export async function cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.cancelAppointment(
      req,
      param(req, 'appointmentId'),
      body(req, cancelSchema),
    );
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function checkIn(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.checkIn(req, param(req, 'appointmentId'), body(req, checkInSchema));
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}
