import { ComputeViewDoneEvent, Rows, View as ViewConfig } from "./row-manager";
import { Row } from "../row";
import { sort as timSort } from "./timsort";
import { Result } from "../utils/result";
import { wait } from "../utils/wait";
import { isEmptyFast } from "../utils/is-empty-fast";
console.log("Worker initialized");

const letOtherEventsThrough = () => wait(0);

const filterRows = async ({
  filter,
  rowsArr,
  buffer,
  shouldCancel,
  onEarlyResults,
}: {
  filter: ViewConfig["filter"];
  rowsArr: Row[];
  buffer: Int32Array;
  shouldCancel: () => boolean;
  onEarlyResults: (numRows: number) => void;
}): Promise<Result<{ numRows: number }>> => {
  const lowerCaseFilter: Record<number, string> = Object.fromEntries(
    Object.entries(filter).map(([k, v]) => [k, v.toLowerCase()])
  );

  const MIN_RESULTS_EARLY_RESULT = 50;
  const ROW_CHUNK_SIZE = 30000;

  const numChunks = Math.ceil(rowsArr.length / ROW_CHUNK_SIZE);
  let sentEarlyResults = false;
  let offset = 0;

  for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
    const startIndex = chunkIndex * ROW_CHUNK_SIZE;
    const endIndex = Math.min(startIndex + ROW_CHUNK_SIZE, rowsArr.length);

    await letOtherEventsThrough();
    if (shouldCancel()) {
      return { ok: false, error: "filter-cancelled" };
    }

    if (
      !sentEarlyResults &&
      offset > MIN_RESULTS_EARLY_RESULT &&
      rowsArr.length > 70000 &&
      startIndex > 30000
    ) {
      // makes filtering look super fast
      onEarlyResults(offset);
      sentEarlyResults = true;
    }

    for (let i = startIndex; i < endIndex; i++) {
      const row = rowsArr[i]!;
      let matchesFilter = true;

      for (const column in lowerCaseFilter) {
        if (
          String(row.cells[column].v)
            .toLowerCase()
            .indexOf(lowerCaseFilter[column]) === -1
        ) {
          matchesFilter = false;
          break;
        }
      }

      if (matchesFilter) {
        Atomics.store(buffer, offset, row.id);
        offset += 1;
      }
    }
  }
  return { ok: true, value: { numRows: offset } };
};

const getSortComparisonFn = (
  config: ["ascending" | "descending" | null, number][]
) => {
  return (a: Row, b: Row) => {
    for (let col = 0; col < config.length; col++) {
      const [direction, colIndex] = config[col];
      // const colIndex = config[col].column;
      if (direction === null) {
        continue;
      }
      if (direction === "ascending") {
        if (a.cells[colIndex].v > b.cells[colIndex].v) {
          return 1;
        } else if (a.cells[colIndex].v < b.cells[colIndex].v) {
          return -1;
        }
      }
      if (a.cells[colIndex].v < b.cells[colIndex].v) {
        return 1;
      } else if (a.cells[colIndex].v > b.cells[colIndex].v) {
        return -1;
      }
    }
    return 0;
  };
};

const computeView = async ({
  rows,
  buffer,
  viewConfig,
  shouldCancel,
}: {
  rows: Rows;
  buffer: Int32Array;
  viewConfig: ViewConfig;
  shouldCancel: () => boolean;
}): Promise<number | "cancelled"> => {
  const sortConfig = viewConfig.sort;

  let rowsArr = rows;

  const sortKey = JSON.stringify(sortConfig);
  if (sortKey === cache.sortKey) {
    rowsArr = cache.sort ?? rows;
  } else if (!isEmptyFast(sortConfig)) {
    rowsArr = [...rows];

    const start = performance.now();
    const sortResult = await timSort(
      rowsArr,
      getSortComparisonFn(sortConfig.map((c) => [c.direction, c.column])),
      shouldCancel
    );
    if (!sortResult.ok) {
      return "cancelled";
    }
    console.log("sorting took", performance.now() - start);

    cache.sort = rowsArr;
    cache.sortKey = sortKey;
  }

  await letOtherEventsThrough();
  if (shouldCancel()) {
    return "cancelled";
  }

  if (isEmptyFast(viewConfig.filter)) {
    const start = performance.now();
    for (let i = 0; i < rowsArr.length; i++) {
      Atomics.store(buffer, i, rowsArr[i]!.id);
    }
    console.log(
      "returning early after sort, wrote buffer ms:",
      performance.now() - start
    );
    return rowsArr.length;
  }

  const start = performance.now();
  const result = await filterRows({
    filter: viewConfig.filter,
    buffer,
    rowsArr,
    onEarlyResults: (numRows: number) => {
      console.log("early results", numRows);
      self.postMessage({
        type: "compute-view-done",
        numRows,
        skipRefreshThumb: true,
      } satisfies ComputeViewDoneEvent);
    },
    shouldCancel,
  });

  await letOtherEventsThrough();
  if (shouldCancel() || !result.ok) {
    return "cancelled";
  }

  console.log(
    "filtering happened, num rows:",
    result.value.numRows,
    "ms:",
    performance.now() - start
  );
  return result.value.numRows;
};

// Ensure viewConfig can handle all columns for sorting and filtering
export interface ViewConfig {
  filter: Record<number, string>;
  sort: { direction: "ascending" | "descending"; column: number }[];
  version: number;
}

let rowData: Rows = [];

let currentFilterId: [number] = [0];

const cache = {
  sort: null as Row[] | null,
  sortKey: null as string | null,
};

const updateView = () => {
  // Function logic here or remove if not needed
};

const renderCells = () => {
  // Function logic here or remove if not needed
};

const handleEvent = async (event: Message) => {
  const message = event.data;
  switch (message.type) {
    case "compute-view": {
      currentFilterId[0] = message.viewConfig.version;
      const shouldCancel = () => {
        if (message.viewConfig.version !== currentFilterId[0]) {
          console.log(
            "cancelled computation of view",
            message.viewConfig.version,
            currentFilterId[0]
          );
        }
        return message.viewConfig.version !== currentFilterId[0];
      };
      const numRows = await computeView({
        viewConfig: message.viewConfig,
        buffer: message.viewBuffer,
        rows: rowData,
        shouldCancel,
      });

      // NOTE(gab): let other events stream through & check if any of them invalidates this one
      await letOtherEventsThrough();
      if (shouldCancel() || numRows === "cancelled") {
        console.error("cancelled");
        self.postMessage({ type: "compute-view-cancelled" });
        return;
      }

      self.postMessage({ type: "compute-view-done", numRows });
      return;
    }
    case "set-rows": {
      rowData = message.rows;
      cache.sort = null;
      return;
    }
    case "scroll": {
      // Handle scrolling event
      const scrollPosition = message.scrollPosition;
      // Update view based on scroll position
      updateView();
      // Render cell contents
      renderCells();
      self.postMessage({ type: "scroll-done" });
      return;
    }
  }
};

export type ComputeViewEvent = {
  type: "compute-view";
  viewBuffer: Int32Array;
  viewConfig: ViewConfig;
};

export type SetRowsEvent = {
  type: "set-rows";
  rows: Rows;
};

export type ScrollEvent = {
  type: "scroll";
  scrollPosition: number;
};

export type Message = MessageEvent<
  ComputeViewEvent | SetRowsEvent | ScrollEvent
>;

self.addEventListener("message", (event: Message) => {
  handleEvent(event);
});
