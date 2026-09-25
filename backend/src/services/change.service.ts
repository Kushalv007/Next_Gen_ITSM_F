import { PrismaClient, Role, ChangeStatus, ChangeRisk, Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { createNotification } from './notification.service';

const prisma = new PrismaClient();

export interface ChangeFilters {
  status?: string;
  risk?: string;
  search?: string;
  ownerId?: string;
}

export interface CreateChangeInput {
  title: string;
  description: string;
  risk?: ChangeRisk;
  implementationPlan: string;
  rollbackPlan: string;
  scheduledDate?: string | Date;
}

export interface UpdateChangeInput {
  title?: string;
  description?: string;
  risk?: ChangeRisk;
  implementationPlan?: string;
  rollbackPlan?: string;
  scheduledDate?: string | Date | null;
  status?: ChangeStatus;
}

export async function generateChangeNumber(): Promise<string> {
  const latest = await prisma.change.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { changeNumber: true },
  });

  let nextNum = 1;
  if (latest && latest.changeNumber.startsWith('CHG')) {
    const numPart = parseInt(latest.changeNumber.replace('CHG', ''), 10);
    if (!isNaN(numPart)) {
      nextNum = numPart + 1;
    }
  }

  return `CHG${String(nextNum).padStart(6, '0')}`;
}

export async function listChanges(filters: ChangeFilters = {}) {
  const where: Prisma.ChangeWhereInput = {};

  if (filters.status && filters.status !== 'ALL') {
    where.status = filters.status as ChangeStatus;
  }

  if (filters.risk && filters.risk !== 'ALL') {
    where.risk = filters.risk as ChangeRisk;
  }

  if (filters.ownerId) {
    where.ownerId = filters.ownerId;
  }

  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { changeNumber: { contains: term, mode: 'insensitive' } },
      { title: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
      { implementationPlan: { contains: term, mode: 'insensitive' } },
    ];
  }

  return prisma.change.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function getChangeById(id: string) {
  const change = await prisma.change.findUnique({
    where: { id },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });

  if (!change) {
    throw new AppError('Change record not found', 404);
  }

  return change;
}

export async function createChange(
  data: CreateChangeInput,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only technicians and admins can create change requests.', 403);
  }

  if (!data.title || !data.description || !data.implementationPlan || !data.rollbackPlan) {
    throw new AppError('Title, description, implementation plan, and rollback plan are required.', 400);
  }

  const changeNumber = await generateChangeNumber();

  return prisma.change.create({
    data: {
      changeNumber,
      title: data.title.trim(),
      description: data.description.trim(),
      risk: data.risk ?? ChangeRisk.LOW,
      implementationPlan: data.implementationPlan.trim(),
      rollbackPlan: data.rollbackPlan.trim(),
      scheduledDate: data.scheduledDate ? new Date(data.scheduledDate) : null,
      status: ChangeStatus.DRAFT,
      ownerId: user.userId,
    },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function updateChange(
  id: string,
  data: UpdateChangeInput,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only technicians and admins can update changes.', 403);
  }

  const existing = await prisma.change.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Change record not found', 404);
  }

  const updateData: Prisma.ChangeUpdateInput = {};
  if (data.title !== undefined) updateData.title = data.title.trim();
  if (data.description !== undefined) updateData.description = data.description.trim();
  if (data.risk !== undefined) updateData.risk = data.risk;
  if (data.implementationPlan !== undefined) updateData.implementationPlan = data.implementationPlan.trim();
  if (data.rollbackPlan !== undefined) updateData.rollbackPlan = data.rollbackPlan.trim();
  if (data.scheduledDate !== undefined) {
    updateData.scheduledDate = data.scheduledDate ? new Date(data.scheduledDate) : null;
  }
  if (data.status !== undefined) updateData.status = data.status;

  return prisma.change.update({
    where: { id },
    data: updateData,
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function approveOrRejectChange(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  user: { userId: string; role: Role }
) {
  // Only Managers and Admins (Technician/Admin) can approve or reject
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only managers and administrators can approve or reject changes.', 403);
  }

  const existing = await prisma.change.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Change record not found', 404);
  }

  const newStatus = decision === 'APPROVED' ? ChangeStatus.APPROVED : ChangeStatus.REJECTED;

  const updated = await prisma.change.update({
    where: { id },
    data: {
      status: newStatus,
      approverId: user.userId,
      approvedAt: new Date(),
    },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });

  // Notify owner of approval / rejection
  await createNotification(
    updated.ownerId,
    `Change Request ${decision === 'APPROVED' ? 'Approved' : 'Rejected'}`,
    `Your change request ${updated.changeNumber} has been ${decision.toLowerCase()} by ${user.role}.`,
    `/changes/${updated.id}`
  );

  return updated;
}

export async function updateChangeStatus(
  id: string,
  status: ChangeStatus,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only technicians and admins can progress change status.', 403);
  }

  const existing = await prisma.change.findUnique({ where: { id } });
  if (!existing) throw new AppError('Change record not found', 404);

  return prisma.change.update({
    where: { id },
    data: { status },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}
