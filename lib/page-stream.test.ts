import { expect, mock, test } from "bun:test";
import { bindPageStream } from "./page-stream";
test("整页离开释放 SSE，BFCache 返回恢复，卸载后不再恢复", () => {
  const page = new EventTarget();
  const stop = mock(() => {}), resume = mock(() => {});
  const unbind = bindPageStream(page, stop, resume);
  page.dispatchEvent(new Event("pagehide"));
  expect(stop).toHaveBeenCalledTimes(1);
  page.dispatchEvent(new Event("pageshow"));
  expect(resume).not.toHaveBeenCalled();
  const restored = Object.assign(new Event("pageshow"), {persisted:true});
  page.dispatchEvent(restored);
  expect(resume).toHaveBeenCalledTimes(1);
  unbind();
  page.dispatchEvent(restored);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(2);
});
