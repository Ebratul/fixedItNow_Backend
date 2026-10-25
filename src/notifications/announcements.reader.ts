import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

type Audience = "ALL" | "CUSTOMERS" | "WORKERS";

/** What readers (any visitor or user) may see of announcements: only live ones, only public fields. */
@Injectable()
export class AnnouncementsReader {
  constructor(private readonly prisma: PrismaService) {}

  /** A user is addressed as a worker if they started a worker profile, and as a customer unless they only work. */
  async audiencesFor(userId: string): Promise<Audience[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { customerProfile: { select: { id: true } }, workerProfile: { select: { id: true } } } });
    const audiences: Audience[] = ["ALL"];
    if (user?.workerProfile) audiences.push("WORKERS");
    if (user?.customerProfile || !user?.workerProfile) audiences.push("CUSTOMERS");
    return audiences;
  }

  async active(audiences: Audience[]) {
    const now = new Date();
    const rows = await this.prisma.announcement.findMany({
      where: {
        status: "PUBLISHED",
        audience: { in: audiences },
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
      take: 5,
      select: { id: true, title: true, body: true, severity: true, publishedAt: true, endsAt: true },
    });
    return rows;
  }
}
