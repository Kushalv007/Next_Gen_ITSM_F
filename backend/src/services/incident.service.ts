import { PrismaClient, Role, IncidentStatus, IncidentPriority, Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { createNotification } from './notification.service';

const prisma = new PrismaClient();

export interface IncidentFilters {
  status?: string;
  priority?: string;
  category?: string;
  search?: string;
  assignedToId?: string;
}

export interface CreateIncidentInput {
  shortDescription: string;
  description: string;
  category: string;
  priority?: IncidentPriority;
  assetId?: string | null;
}

export interface UpdateIncidentInput {
  status?: IncidentStatus;
  priority?: IncidentPriority;
  assignedToId?: string | null;
  resolutionNotes?: string;
  assetId?: string | null;
  problemId?: string | null;
}

export function calculateSlaDeadline(priority: IncidentPriority): Date {
  const hoursMap: Record<IncidentPriority, number> = {
    [IncidentPriority.CRITICAL]: 2,
    [IncidentPriority.HIGH]: 4,
    [IncidentPriority.MEDIUM]: 8,
    [IncidentPriority.LOW]: 24,
  };
  const hours = hoursMap[priority] ?? 8;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function generateTicketNumber(): Promise<string> {
  const latest = await prisma.incident.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { ticketNumber: true },
  });

  let nextNum = 1;
  if (latest && latest.ticketNumber.startsWith('INC')) {
    const numPart = parseInt(latest.ticketNumber.replace('INC', ''), 10);
    if (!isNaN(numPart)) {
      nextNum = numPart + 1;
    }
  }

  return `INC${String(nextNum).padStart(6, '0')}`;
}

export async function listIncidents(
  user: { userId: string; role: Role },
  filters: IncidentFilters = {}
) {
  const where: Prisma.IncidentWhereInput = {};

  // RBAC: Standard employees only see their own incidents
  if (user.role === Role.User) {
    where.requesterId = user.userId;
  } else if (filters.assignedToId) {
    where.assignedToId = filters.assignedToId;
  }

  if (filters.status && filters.status !== 'ALL') {
    where.status = filters.status as IncidentStatus;
  }

  if (filters.priority && filters.priority !== 'ALL') {
    where.priority = filters.priority as IncidentPriority;
  }

  if (filters.category && filters.category !== 'ALL') {
    where.category = filters.category;
  }

  if (filters.search && filters.search.trim()) {
    const searchTerm = filters.search.trim();
    where.OR = [
      { ticketNumber: { contains: searchTerm, mode: 'insensitive' } },
      { shortDescription: { contains: searchTerm, mode: 'insensitive' } },
      { description: { contains: searchTerm, mode: 'insensitive' } },
    ];
  }

  return prisma.incident.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      asset: {
        select: { id: true, assetTag: true, name: true, type: true },
      },
      problem: {
        select: { id: true, problemNumber: true, title: true, status: true },
      },
      _count: {
        select: { comments: true },
      },
    },
  });
}

export async function getIncidentById(idOrNumber: string, user: { userId: string; role: Role }) {
  const incident = await prisma.incident.findFirst({
    where: {
      OR: [{ id: idOrNumber }, { ticketNumber: idOrNumber }],
    },
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      asset: true,
      problem: true,
      comments: {
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, email: true, role: true },
          },
        },
      },
    },
  });

  if (!incident) {
    throw new AppError('Incident not found', 404);
  }

  // RBAC: Standard user cannot view another employee's incident
  if (user.role === Role.User && incident.requesterId !== user.userId) {
    throw new AppError('Forbidden. You can only view your own incidents.', 403);
  }

  return incident;
}

export async function createIncident(data: CreateIncidentInput, requesterId: string) {
  if (!data.shortDescription || !data.description || !data.category) {
    throw new AppError('shortDescription, description, and category are required.', 400);
  }

  const ticketNumber = await generateTicketNumber();
  const priority = data.priority ?? IncidentPriority.MEDIUM;
  const slaDeadline = calculateSlaDeadline(priority);

  const incidentData: Prisma.IncidentCreateInput = {
    ticketNumber,
    shortDescription: data.shortDescription,
    description: data.description,
    category: data.category,
    priority,
    status: IncidentStatus.NEW,
    requester: { connect: { id: requesterId } },
    slaDeadline,
    slaBreached: false,
  };

  if (data.assetId) {
    incidentData.asset = { connect: { id: data.assetId } };
  }

  return prisma.incident.create({
    data: incidentData,
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      asset: true,
      problem: true,
    },
  });
}

export async function updateIncident(
  id: string,
  data: UpdateIncidentInput,
  user: { userId: string; role: Role }
) {
  const incident = await prisma.incident.findUnique({ where: { id } });
  if (!incident) {
    throw new AppError('Incident not found', 404);
  }

  // RBAC: Only Agents (Technician) and Admins can update status, priority, assignee, or resolution notes
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can update incident details.', 403);
  }

  const updateData: Prisma.IncidentUpdateInput = {};

  if (data.priority) {
    updateData.priority = data.priority;
    if (incident.status !== IncidentStatus.RESOLVED && incident.status !== IncidentStatus.CLOSED) {
      updateData.slaDeadline = calculateSlaDeadline(data.priority);
    }
  }

  if (data.status) {
    updateData.status = data.status;
    if (data.status === IncidentStatus.RESOLVED || data.status === IncidentStatus.CLOSED) {
      const resolvedAt = new Date();
      updateData.resolvedAt = resolvedAt;
      if (incident.slaDeadline && resolvedAt > incident.slaDeadline) {
        updateData.slaBreached = true;
      } else {
        updateData.slaBreached = false;
      }
    }
  }

  if (data.assignedToId !== undefined) {
    if (data.assignedToId === null || data.assignedToId === '') {
      updateData.assignedTo = { disconnect: true };
    } else {
      updateData.assignedTo = { connect: { id: data.assignedToId } };
    }
  }

  if (data.assetId !== undefined) {
    if (data.assetId === null || data.assetId === '') {
      updateData.asset = { disconnect: true };
    } else {
      updateData.asset = { connect: { id: data.assetId } };
    }
  }

  if (data.problemId !== undefined) {
    if (data.problemId === null || data.problemId === '') {
      updateData.problem = { disconnect: true };
    } else {
      updateData.problem = { connect: { id: data.problemId } };
    }
  }

  if (data.resolutionNotes !== undefined) {
    updateData.resolutionNotes = data.resolutionNotes;
  }

  const updated = await prisma.incident.update({
    where: { id },
    data: updateData,
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      asset: true,
      problem: true,
      comments: {
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, email: true, role: true },
          },
        },
      },
    },
  });

  // Trigger Notifications:
  // 1. If assigned to a new agent -> notify that agent
  if (
    data.assignedToId &&
    data.assignedToId !== incident.assignedToId &&
    data.assignedToId !== user.userId
  ) {
    await createNotification(
      data.assignedToId,
      'Incident Assigned',
      `You have been assigned to ticket ${updated.ticketNumber}: ${updated.shortDescription}`,
      `/incidents/${updated.id}`
    );
  }

  // 2. If resolved -> notify requester
  if (data.status === IncidentStatus.RESOLVED && incident.status !== IncidentStatus.RESOLVED) {
    await createNotification(
      updated.requesterId,
      'Incident Resolved',
      `Your incident ${updated.ticketNumber} has been marked as resolved.`,
      `/incidents/${updated.id}`
    );
  }

  return updated;
}

export async function addIncidentComment(
  incidentId: string,
  content: string,
  user: { userId: string; role: Role }
) {
  if (!content || !content.trim()) {
    throw new AppError('Comment content cannot be empty.', 400);
  }

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
  if (!incident) {
    throw new AppError('Incident not found', 404);
  }

  // Both employee (if requester) and agents/admins can comment
  if (user.role === Role.User && incident.requesterId !== user.userId) {
    throw new AppError('Forbidden. You can only comment on your own tickets.', 403);
  }

  return prisma.incidentComment.create({
    data: {
      incidentId,
      userId: user.userId,
      content: content.trim(),
    },
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function getIncidentAgents() {
  return prisma.user.findMany({
    where: {
      role: { in: [Role.Admin, Role.Technician] },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
    },
  });
}
