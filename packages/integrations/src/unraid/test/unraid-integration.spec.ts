// @vitest-environment node

import { Response } from "undici";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fetchWithTrustedCertificatesAsync } from "@homarr/core/infrastructure/http";

import { IntegrationResponseError } from "../../base/errors/http/integration-response-error";
import { IntegrationUnknownError } from "../../base/errors/integration-unknown-error";
import { IntegrationParseError } from "../../base/errors/parse/integration-parse-error";
import { UnraidIntegration } from "../unraid-integration";
import type { UnraidSystemInfo } from "../unraid-types";

vi.hoisted(() => {
  process.env.CI = "true";
  process.env.NODE_ENV = "test";
  process.env.SECRET_ENCRYPTION_KEY = "0".repeat(64);
});

vi.mock("@homarr/core/infrastructure/http", () => ({
  fetchWithTrustedCertificatesAsync: vi.fn(),
}));

vi.mock("@homarr/core/infrastructure/logs", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFetch = vi.mocked(fetchWithTrustedCertificatesAsync);

const createIntegration = () =>
  new UnraidIntegration({
    id: "test-unraid",
    name: "Test Unraid",
    url: "https://unraid.example.com",
    externalUrl: null,
    decryptedSecrets: [{ kind: "apiKey", value: "test-api-key" }],
  });

const arrayDisk = {
  name: "disk1",
  size: 2000,
  fsFree: 1400,
  fsUsed: 500,
  status: "DISK_OK",
  temp: 32,
};

const cacheDisk = {
  name: "cache",
  fsSize: 1000,
  fsFree: 750,
  fsUsed: 250,
  status: "DISK_OK",
  temp: 40,
};

const arrayFileSystem = { deviceName: "disk1", used: "512000", available: "1536000", percentage: 25 };
const cacheFileSystem = { deviceName: "cache", used: "256000", available: "768000", percentage: 25 };

const createSystemInfo = (
  disks: UnraidSystemInfo["array"]["disks"] = [],
  caches: UnraidSystemInfo["array"]["caches"] = [cacheDisk],
) => ({
  metrics: {
    cpu: { percentTotal: 30, cpus: [{ percentTotal: 20 }, { percentTotal: 40 }] },
    memory: { available: 6000, used: 2000, free: 5000, total: 8000, percentTotal: 25 },
  },
  array: {
    state: "STARTED",
    capacity: { disks: { free: "1500", total: "2000", used: "500" } },
    disks,
    caches,
  },
  info: {
    devices: { network: [{ speed: 1000, dhcp: true, model: "Ethernet" }] },
    os: { platform: "linux", distro: "Unraid", release: "7.2.4", uptime: "2026-09-11T00:00:00Z" },
    cpu: { manufacturer: "Intel", brand: "Test CPU", cores: 1, threads: 2 },
    memory: { layout: [{ size: 4000 }, { size: 4000 }] },
  },
});

const mockResponse = (body: unknown, status = 200) => {
  mockFetch.mockImplementation(
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as ReturnType<typeof fetchWithTrustedCertificatesAsync>,
  );
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T01:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UnraidIntegration.getSystemInfoAsync", () => {
  test("maps pool-only storage and preserves CPU, memory, and uptime", async () => {
    mockResponse({ data: createSystemInfo() });

    const result = await createIntegration().getSystemInfoAsync();

    expect(result.fileSystem).toStrictEqual([cacheFileSystem]);
    expect(result.smart).toStrictEqual([
      { deviceName: "cache", temperature: 40, overallStatus: "DISK_OK", healthy: true },
    ]);
    expect(result).toMatchObject({
      version: "7.2.4",
      cpuModelName: "Test CPU",
      cpuUtilization: 30,
      memUsedInBytes: 2000,
      memAvailableInBytes: 6000,
      uptime: 3600,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, request] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://unraid.example.com/graphql");
    expect(request).toMatchObject({ method: "POST", headers: { "x-api-key": "test-api-key" } });
    const { query } = JSON.parse(String(request?.body)) as { query: string };
    expect(query).toMatch(
      /array\s*\{[\s\S]*caches\s*\{\s*name\s+fsSize\s+fsFree\s+fsUsed\s+status\s+temp\s*\}/,
    );
  });

  test("preserves array calculations and appends pools in API order using filesystem capacity", async () => {
    const cacheWithPhysicalSize = { ...cacheDisk, size: 4000 };
    mockResponse({
      data: createSystemInfo([arrayDisk, { ...arrayDisk, name: "disk2" }], [
        cacheWithPhysicalSize,
        { ...cacheDisk, name: "fast", fsSize: 2000, fsUsed: 1000, fsFree: 800 },
      ]),
    });

    const result = await createIntegration().getSystemInfoAsync();

    expect(result.fileSystem).toStrictEqual([
      arrayFileSystem,
      { ...arrayFileSystem, deviceName: "disk2" },
      cacheFileSystem,
      { deviceName: "fast", used: "1024000", available: "819200", percentage: 50 },
    ]);
    expect(result.smart).toStrictEqual([
      { deviceName: "disk1", temperature: 32, overallStatus: "DISK_OK", healthy: true },
      { deviceName: "disk2", temperature: 32, overallStatus: "DISK_OK", healthy: true },
      { deviceName: "cache", temperature: 40, overallStatus: "DISK_OK", healthy: true },
      { deviceName: "fast", temperature: 40, overallStatus: "DISK_OK", healthy: true },
    ]);
  });

  test("keeps SMART data for secondary pool members without filesystem capacity", async () => {
    mockResponse({
      data: createSystemInfo([], [
        cacheDisk,
        { ...cacheDisk, name: "cache2", fsSize: null, fsFree: null, fsUsed: null, temp: null },
        {
          name: "cache3",
          fsSize: null,
          fsFree: null,
          fsUsed: null,
          status: "DISK_DSBL",
        },
      ]),
    });

    const result = await createIntegration().getSystemInfoAsync();

    expect(result.fileSystem).toStrictEqual([cacheFileSystem]);
    expect(result.smart).toStrictEqual([
      { deviceName: "cache", temperature: 40, overallStatus: "DISK_OK", healthy: true },
      { deviceName: "cache2", temperature: null, overallStatus: "DISK_OK", healthy: true },
      { deviceName: "cache3", temperature: null, overallStatus: "DISK_DSBL", healthy: false },
    ]);
  });

  test.each([
    { fsSize: null },
    { fsFree: null },
    { fsUsed: null },
    { fsSize: 0 },
    { fsSize: -1 },
    { fsFree: -1 },
    { fsUsed: -1 },
  ])("skips unusable pool capacity %j while preserving valid storage", async (capacity) => {
    mockResponse({
      data: createSystemInfo([arrayDisk], [cacheDisk, { ...cacheDisk, name: "invalid", ...capacity }]),
    });

    const result = await createIntegration().getSystemInfoAsync();

    expect(result.fileSystem).toStrictEqual([arrayFileSystem, cacheFileSystem]);
    expect(result.smart.map((disk) => disk.deviceName)).toStrictEqual(["disk1", "cache", "invalid"]);
  });

  test("preserves empty and full pools and their health data", async () => {
    mockResponse({
      data: createSystemInfo([], [
        { ...cacheDisk, name: "empty", fsUsed: 0, fsFree: 1000, temp: 0 },
        { ...cacheDisk, name: "full", fsUsed: 1000, fsFree: 0, status: "DISK_DSBL", temp: null },
      ]),
    });

    const result = await createIntegration().getSystemInfoAsync();

    expect(result.fileSystem).toStrictEqual([
      { deviceName: "empty", used: "0", available: "1024000", percentage: 0 },
      { deviceName: "full", used: "1024000", available: "0", percentage: 100 },
    ]);
    expect(result.smart).toStrictEqual([
      { deviceName: "empty", temperature: 0, overallStatus: "DISK_OK", healthy: true },
      { deviceName: "full", temperature: null, overallStatus: "DISK_DSBL", healthy: false },
    ]);
  });

  test.each([true, false])("preserves array-only responses (caches omitted: %s)", async (omitCaches) => {
    const data = createSystemInfo([arrayDisk], []);
    mockResponse({ data: { ...data, array: { ...data.array, caches: omitCaches ? undefined : [] } } });

    const result = await createIntegration().getSystemInfoAsync();

    expect(result.fileSystem).toStrictEqual([arrayFileSystem]);
    expect(result.smart).toStrictEqual([
      { deviceName: "disk1", temperature: 32, overallStatus: "DISK_OK", healthy: true },
    ]);
    expect(result).toMatchObject({ cpuUtilization: 30, memUsedInBytes: 2000, memAvailableInBytes: 6000 });
  });

  test.each([{ caches: [] }, { caches: [{ ...cacheDisk, fsSize: null, fsFree: null, fsUsed: null }] }])(
    "returns no filesystem entries when no storage has usable capacity: %j",
    async ({ caches }) => {
      mockResponse({ data: createSystemInfo([], caches) });

      const result = await createIntegration().getSystemInfoAsync();

      expect(result.fileSystem).toStrictEqual([]);
    },
  );

  test("rejects HTTP failures through integration error handling", async () => {
    mockResponse({ message: "Service unavailable" }, 503);

    await expect(createIntegration().getSystemInfoAsync()).rejects.toBeInstanceOf(IntegrationResponseError);
  });

  test("rejects GraphQL errors even when data is present", async () => {
    mockResponse({ data: createSystemInfo(), errors: [{ message: "Access denied" }] });

    await expect(createIntegration().getSystemInfoAsync()).rejects.toMatchObject({
      constructor: IntegrationUnknownError,
      cause: { message: "GraphQL errors: Access denied" },
    });
  });

  test.each(["fsSize", "fsFree", "fsUsed"])("rejects malformed non-null %s instead of coercing it", async (field) => {
    const data = createSystemInfo();
    mockResponse({ data: { ...data, array: { ...data.array, caches: [{ ...cacheDisk, [field]: "1000" }] } } });

    await expect(createIntegration().getSystemInfoAsync()).rejects.toBeInstanceOf(IntegrationParseError);
  });
});
