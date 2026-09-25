import { PrismaClient, Role, RequestStatus, ApprovalStatus, Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { createNotification } from './notification.service';

const prisma = new PrismaClient();

export async function generateRequestNumber(): Promise<string> {
  const latest = await prisma.serviceRequest.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { requestNumber: true },
  });

  let nextNum = 1;
  if (latest && latest.requestNumber.startsWith('REQ')) {
    const numPart = parseInt(latest.requestNumber.replace('REQ', ''), 10);
    if (!isNaN(numPart)) {
      nextNum = numPart + 1;
    }
  }

  return `REQ${String(nextNum).padStart(6, '0')}`;
}

export async function listCatalogItems(category?: string) {
  const where: Prisma.ServiceCatalogItemWhereInput = { isActive: true };
  if (category && category !== 'ALL') {
    where.category = category;
  }

  return prisma.serviceCatalogItem.findMany({
    where,
    orderBy: { name: 'asc' },
  });
}

export async function getCatalogItemById(id: string) {
  const item = await prisma.serviceCatalogItem.findUnique({ where: { id } });
  if (!item) {
    throw new AppError('Service catalog item not found', 404);
  }
  return item;
}

export async function createServiceRequest(
  data: { serviceCatalogItemId: string; description: string },
  requesterId: string
) {
  if (!data.serviceCatalogItemId || !data.description) {
    throw new AppError('serviceCatalogItemId and description are required.', 400);
  }

  const catalogItem = await prisma.serviceCatalogItem.findUnique({
    where: { id: data.serviceCatalogItemId },
  });

  if (!catalogItem) {
    throw new AppError('Selected service catalog item does not exist.', 404);
  }

  const requestNumber = await generateRequestNumber();

  return prisma.serviceRequest.create({
    data: {
      requestNumber,
      serviceCatalogItemId: data.serviceCatalogItemId,
      requesterId,
      description: data.description,
      status: RequestStatus.SUBMITTED,
      approvalStatus: ApprovalStatus.PENDING,
    },
    include: {
      catalogItem: true,
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function listServiceRequests(
  user: { userId: string; role: Role },
  filters: { status?: string; search?: string } = {}
) {
  const where: Prisma.ServiceRequestWhereInput = {};

  if (user.role === Role.User) {
    where.requesterId = user.userId;
  }

  if (filters.status && filters.status !== 'ALL') {
    where.status = filters.status as RequestStatus;
  }

  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { requestNumber: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
      { catalogItem: { name: { contains: term, mode: 'insensitive' } } },
    ];
  }

  return prisma.serviceRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      catalogItem: true,
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function getServiceRequestById(
  idOrNumber: string,
  user: { userId: string; role: Role }
) {
  const request = await prisma.serviceRequest.findFirst({
    where: {
      OR: [{ id: idOrNumber }, { requestNumber: idOrNumber }],
    },
    include: {
      catalogItem: true,
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });

  if (!request) {
    throw new AppError('Service request not found', 404);
  }

  if (user.role === Role.User && request.requesterId !== user.userId) {
    throw new AppError('Forbidden. You can only view your own service requests.', 403);
  }

  return request;
}

export async function updateServiceRequest(
  id: string,
  data: { status?: RequestStatus; assignedToId?: string | null },
  user: { userId: string; role: Role }
) {
  const request = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!request) {
    throw new AppError('Service request not found', 404);
  }

  // Only Agent/Admin can update status or assignment
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can update service requests.', 403);
  }

  const updateData: Prisma.ServiceRequestUpdateInput = {};
  if (data.status) {
    updateData.status = data.status;
  }
  if (data.assignedToId !== undefined) {
    if (data.assignedToId === null || data.assignedToId === '') {
      updateData.assignedTo = { disconnect: true };
    } else {
      updateData.assignedTo = { connect: { id: data.assignedToId } };
    }
  }

  const updated = await prisma.serviceRequest.update({
    where: { id },
    data: updateData,
    include: {
      catalogItem: true,
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });

  // Notification: notify requester when request status is updated
  if (data.status && data.status !== request.status) {
    await createNotification(
      updated.requesterId,
      'Request Updated',
      `Your service request ${updated.requestNumber} status has been updated to ${updated.status}.`,
      `/requests/${updated.id}`
    );
  }

  return updated;
}

export async function approveOrRejectRequest(
  id: string,
  approvalStatus: ApprovalStatus,
  user: { userId: string; role: Role }
) {
  // Only Managers and Admins (Technician/Admin) can approve or reject
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only managers and administrators can approve or reject requests.', 403);
  }

  const request = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!request) {
    throw new AppError('Service request not found', 404);
  }

  const status = approvalStatus === ApprovalStatus.APPROVED ? RequestStatus.IN_PROGRESS : RequestStatus.REJECTED;

  const updated = await prisma.serviceRequest.update({
    where: { id },
    data: {
      approvalStatus,
      status,
      approverId: user.userId,
      approvedAt: new Date(),
    },
    include: {
      catalogItem: true,
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });

  // Notification: notify requester on approval or rejection
  const actionText = approvalStatus === ApprovalStatus.APPROVED ? 'Approved' : 'Rejected';
  await createNotification(
    updated.requesterId,
    `Request ${actionText}`,
    `Your request ${updated.requestNumber} has been ${actionText.toLowerCase()} by ${user.role}.`,
    `/requests/${updated.id}`
  );

  return updated;
}
