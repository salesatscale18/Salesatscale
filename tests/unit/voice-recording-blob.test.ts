/**
 * The Vercel Blob store for call recordings (lib/voice/recording-blob.ts) against a mocked @vercel/blob: the
 * sources' conventions (private, token, no random suffix), list paging, range reads, delete by path. No network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ put: [] as unknown[][], list: [] as unknown[], get: [] as unknown[][], del: [] as unknown[][] }));
vi.mock("@vercel/blob", () => ({
  put: async (...a: unknown[]) => { calls.put.push(a); return { url: "u" }; },
  list: async (o: { cursor?: string }) => {
    calls.list.push(o);
    return o.cursor
      ? { blobs: [{ pathname: "voice/production/a/s/00002.pcm", size: 8, url: "x2" }], hasMore: false }
      : { blobs: [{ pathname: "voice/production/a/s/00001.pcm", size: 8, url: "x1" }], hasMore: true, cursor: "c1" };
  },
  get: async (...a: unknown[]) => { calls.get.push(a); return { statusCode: 200, stream: new Response(new Uint8Array([3, 4, 5])).body }; },
  del: async (...a: unknown[]) => { calls.del.push(a); },
}));

const { blobRecordingStore } = await import("@/lib/voice/recording-blob");

describe("call recordings in Vercel Blob", () => {
  beforeEach(() => { calls.put = []; calls.list = []; calls.get = []; calls.del = []; });

  it("no token: no store", () => {
    expect(blobRecordingStore({})).toBeNull();
    expect(blobRecordingStore({ BLOB_READ_WRITE_TOKEN: "" })).toBeNull();
  });

  it("puts private chunks at their path; lists every page in order; reads a range; deletes by path", async () => {
    const s = blobRecordingStore({ BLOB_READ_WRITE_TOKEN: "tok" })!;
    await s.put("voice/production/a/s/00001.pcm", new Uint8Array([1, 2]), { ttlDays: 90 });
    expect(calls.put[0][0]).toBe("voice/production/a/s/00001.pcm");
    expect(calls.put[0][2]).toEqual({ access: "private", contentType: "application/octet-stream", token: "tok", addRandomSuffix: false, allowOverwrite: true });
    expect(await s.list("voice/production/a/s/")).toEqual([{ path: "voice/production/a/s/00001.pcm", size: 8 }, { path: "voice/production/a/s/00002.pcm", size: 8 }]);
    expect(calls.list).toHaveLength(2);
    expect(Array.from(await s.read("voice/production/a/s/00001.pcm", 3, 6))).toEqual([3, 4, 5]);
    expect(calls.get[0][1]).toMatchObject({ access: "private", token: "tok", useCache: false, headers: { range: "bytes=3-5" } });
    await s.deleteAll("voice/production/a/s/");
    expect(calls.del[0]).toEqual([["voice/production/a/s/00001.pcm", "voice/production/a/s/00002.pcm"], { token: "tok" }]);
  });
});
