/**
 * Application tracker: CRUD over the locally stored application list, plus
 * helpers for follow-up reminders and creating an entry from a job listing.
 */
import type { Application, ApplicationStatus, Job } from "../types/index.js";
import { getApplications, setApplications } from "../lib/storage.js";
import { uid } from "../lib/util.js";

export interface NewApplicationInput {
  title: string;
  company: string;
  url?: string;
  jobId?: string;
  status?: ApplicationStatus;
  notes?: string;
  followUpAt?: number | null;
  resumeVariant?: string;
  jobDescription?: string;
}

export async function listApplications(): Promise<Application[]> {
  const apps = await getApplications();
  return apps.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function addApplication(input: NewApplicationInput): Promise<Application> {
  const apps = await getApplications();
  const now = Date.now();
  const app: Application = {
    id: uid("app"),
    title: input.title.trim() || "Untitled role",
    company: input.company.trim(),
    status: input.status ?? "saved",
    createdAt: now,
    updatedAt: now,
  };
  if (input.url) app.url = input.url;
  if (input.jobId) app.jobId = input.jobId;
  if (input.notes) app.notes = input.notes;
  if (input.followUpAt != null) app.followUpAt = input.followUpAt;
  if (input.resumeVariant) app.resumeVariant = input.resumeVariant;
  if (input.jobDescription) app.jobDescription = input.jobDescription;
  if (app.status === "applied") app.appliedAt = now;

  apps.push(app);
  await setApplications(apps);
  return app;
}

export async function updateApplication(
  id: string,
  patch: Partial<Omit<Application, "id" | "createdAt">>,
): Promise<Application | null> {
  const apps = await getApplications();
  const idx = apps.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const prev = apps[idx];
  const next: Application = { ...prev, ...patch, id: prev.id, createdAt: prev.createdAt, updatedAt: Date.now() };
  if (patch.status === "applied" && !prev.appliedAt) next.appliedAt = Date.now();
  apps[idx] = next;
  await setApplications(apps);
  return next;
}

export async function deleteApplication(id: string): Promise<void> {
  const apps = await getApplications();
  await setApplications(apps.filter((a) => a.id !== id));
}

/** Create (or find an existing) application for a job listing. */
export async function trackJob(
  job: Pick<Job, "id" | "title" | "company" | "url" | "descriptionText">,
  status: ApplicationStatus = "saved",
): Promise<Application> {
  const apps = await getApplications();
  const existing = apps.find((a) => a.jobId === job.id);
  if (existing) return existing;
  return addApplication({
    title: job.title,
    company: job.company,
    url: job.url,
    jobId: job.id,
    status,
    jobDescription: job.descriptionText,
  });
}

/** Applications whose follow-up time is due (<= now) and still open. */
export function dueFollowUps(apps: Application[], now = Date.now()): Application[] {
  return apps.filter(
    (a) =>
      typeof a.followUpAt === "number" &&
      a.followUpAt <= now &&
      a.status !== "rejected" &&
      a.status !== "withdrawn" &&
      a.status !== "offer",
  );
}

/** Stable key used to avoid re-notifying for the same scheduled follow-up. */
export function followUpKey(app: Application): string {
  return `${app.id}:${app.followUpAt}`;
}
