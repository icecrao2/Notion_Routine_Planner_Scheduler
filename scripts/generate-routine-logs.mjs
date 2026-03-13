const {
  NOTION_TOKEN,
  ROUTINE_PLAN_DS_ID,
  ROUTINE_LOG_DS_ID,
  PLAN_TITLE_PROPERTY = "루틴",
  PLAN_STATUS_PROPERTY = "상태",
  PLAN_DATE_PROPERTY = "날짜",
  LOG_TITLE_PROPERTY = "Name",
  LOG_DATE_PROPERTY = "날짜",
  LOG_DONE_PROPERTY = "수행",
  LOG_PLAN_RELATION_PROPERTY = "루틴계획",
  TARGET_STATUS = "진행 중",
  NOTION_VERSION = "2026-03-11",
} = process.env;

const NOTION_BASE_URL = "https://api.notion.com/v1";

validateEnv();

async function main() {
  const today = getKstDateString(new Date());
  console.log(`[START] today=${today}`);

  const activePlans = await queryAllPages(`/data_sources/${ROUTINE_PLAN_DS_ID}/query`, {
    filter: {
      property: PLAN_STATUS_PROPERTY,
      status: { equals: TARGET_STATUS },
    },
  });

  const todayLogs = await queryAllPages(`/data_sources/${ROUTINE_LOG_DS_ID}/query`, {
    filter: {
      property: LOG_DATE_PROPERTY,
      date: { equals: today },
    },
  });

  const existingPlanIds = new Set();
  for (const logPage of todayLogs) {
    const relation = logPage.properties?.[LOG_PLAN_RELATION_PROPERTY]?.relation ?? [];
    for (const item of relation) {
      if (item.id) existingPlanIds.add(item.id);
    }
  }

  let createdCount = 0;

  for (const planPage of activePlans) {
    if (!isTodayIncluded(planPage, today)) continue;
    if (existingPlanIds.has(planPage.id)) continue;

    const planTitle = getPageTitle(planPage, PLAN_TITLE_PROPERTY);
    const todoBlocks = await extractTodoBlocksRecursively(planPage.id);

    const createdPage = await notionRequest("/pages", "POST", {
      parent: { data_source_id: ROUTINE_LOG_DS_ID },
      properties: {
        [LOG_TITLE_PROPERTY]: {
          title: [
            {
              type: "text",
              text: { content: planTitle },
            },
          ],
        },
        [LOG_DATE_PROPERTY]: {
          date: { start: today },
        },
        [LOG_DONE_PROPERTY]: {
          checkbox: false,
        },
        [LOG_PLAN_RELATION_PROPERTY]: {
          relation: [{ id: planPage.id }],
        },
      },
    });

    const children = [
      heading2("오늘 수행 체크리스트"),
      ...todoBlocks,
      heading2("한 줄 기록(선택)"),
      bullet(""),
    ];

    await appendChildren(createdPage.id, children);

    createdCount += 1;
    console.log(`[CREATED] ${planTitle}`);
  }

  console.log(`[DONE] createdCount=${createdCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function validateEnv() {
  const required = ["NOTION_TOKEN", "ROUTINE_PLAN_DS_ID", "ROUTINE_LOG_DS_ID"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }
}

async function notionRequest(path, method = "GET", body) {
  const res = await fetch(`${NOTION_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[Notion ${method} ${path}] ${res.status} ${text}`);
  }

  return res.json();
}

async function queryAllPages(path, baseBody) {
  const results = [];
  let startCursor;

  while (true) {
    const body = startCursor
      ? { ...baseBody, start_cursor: startCursor }
      : baseBody;

    const data = await notionRequest(path, "POST", body);
    results.push(...(data.results ?? []));

    if (!data.has_more) break;
    startCursor = data.next_cursor;
  }

  return results;
}

async function listAllBlockChildren(blockId) {
  const all = [];
  let startCursor;

  while (true) {
    const query = new URLSearchParams({ page_size: "100" });
    if (startCursor) query.set("start_cursor", startCursor);

    const data = await notionRequest(`/blocks/${blockId}/children?${query.toString()}`, "GET");
    all.push(...(data.results ?? []));

    if (!data.has_more) break;
    startCursor = data.next_cursor;
  }

  return all;
}

async function extractTodoBlocksRecursively(blockId) {
  const children = await listAllBlockChildren(blockId);
  const result = [];

  for (const block of children) {
    if (block.type === "to_do") {
      result.push(await cloneTodoBlock(block));
      continue;
    }

    if (block.has_children) {
      const nested = await extractTodoBlocksRecursively(block.id);
      result.push(...nested);
    }
  }

  return result;
}

async function cloneTodoBlock(block) {
  const cloned = {
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: block.to_do?.rich_text ?? [],
      checked: false,
      color: block.to_do?.color ?? "default",
    },
  };

  if (block.has_children) {
    const directChildren = await listAllBlockChildren(block.id);
    const todoChildren = [];

    for (const child of directChildren) {
      if (child.type === "to_do") {
        todoChildren.push(await cloneTodoBlock(child));
      } else if (child.has_children) {
        const nested = await extractTodoBlocksRecursively(child.id);
        todoChildren.push(...nested);
      }
    }

    if (todoChildren.length > 0) {
      cloned.to_do.children = todoChildren;
    }
  }

  return cloned;
}

async function appendChildren(blockId, children) {
  if (!children.length) return;

  const chunkSize = 100;

  for (let i = 0; i < children.length; i += chunkSize) {
    const chunk = children.slice(i, i + chunkSize);

    await notionRequest(`/blocks/${blockId}/children`, "PATCH", {
      children: chunk,
    });
  }
}

function getPageTitle(page, propertyName) {
  const titleArr = page.properties?.[propertyName]?.title ?? [];
  const text = titleArr.map((item) => item.plain_text ?? "").join("").trim();
  return text || "제목 없음";
}

function isTodayIncluded(page, today) {
  const dateProp = page.properties?.[PLAN_DATE_PROPERTY]?.date;
  if (!dateProp?.start) return false;

  const start = dateProp.start.slice(0, 10);
  const end = (dateProp.end ?? dateProp.start).slice(0, 10);

  return start <= today && today <= end;
}

function getKstDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  return `${y}-${m}-${d}`;
}

function heading2(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [
        {
          type: "text",
          text: { content: text },
        },
      ],
    },
  };
}

function bullet(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: text
        ? [
            {
              type: "text",
              text: { content: text },
            },
          ]
        : [],
    },
  };
}
