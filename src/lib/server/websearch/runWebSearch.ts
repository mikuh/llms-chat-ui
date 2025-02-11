import { MarkdownElementType } from "$lib/server/websearch/markdown/types";
import { removeParents } from "$lib/server/websearch/markdown/tree";

import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import type { WebSearch, WebSearchScrapedSource, WebSearchUsedSource } from "$lib/types/WebSearch";
import type { Assistant } from "$lib/types/Assistant";
import type { MessageWebSearchUpdate } from "$lib/types/MessageUpdate";

import { search } from "./search/search";
import {
    makeErrorUpdate,
    makeFinalAnswerUpdate,
    makeSourcesUpdate,
    makeGeneralUpdate,
} from "./update";

import { MetricsServer } from "../metrics";
import { logger } from "$lib/server/logger";

const MAX_OUTPUT_RESULTS = 5 as const; // 设置最大显示结果数

export async function* runWebSearch(
    conv: Conversation,
    messages: Message[],
    ragSettings?: Assistant["rag"],
    query?: string
): AsyncGenerator<MessageWebSearchUpdate, WebSearch, undefined> {
    const prompt = messages[messages.length - 1].content;
    const createdAt = new Date();
    const updatedAt = new Date();

    MetricsServer.getMetrics().webSearch.requestCount.inc();

    try {
        // Step 1: 执行网页搜索
        const { searchQuery, pages } = yield* search(messages, ragSettings, query);
        if (pages.length === 0) throw Error("No results found for this search query");

        yield makeGeneralUpdate({ message: "Generating search context" });

        // Step 2: 直接处理搜索结果
        const validResults = pages
            .filter(p => p.snippet) // 过滤掉没有snippet的内容
            .slice(0, MAX_OUTPUT_RESULTS);

        // Step 3: 构造上下文数据
        const contextSources: WebSearchUsedSource[] = validResults.map((result, idx) => {
            // 构建符合类型要求的虚拟页面结构
            const placeholderScrapedSource: WebSearchScrapedSource = {
                title: result.title,
                link: result.link,
                page: {
                    title: result.title || "",
                    markdownTree: {
                        type: MarkdownElementType.Root,
                        children: [
                            {
                                type: MarkdownElementType.Paragraph,
                                content: result.snippet,
                                children: [],
                            }
                        ],
                        content: result.title + "\n" + result.link,
                    },
                    siteName: undefined,
                    author: undefined,
                    description: undefined,
                    createdAt: undefined,
                    modifiedAt: undefined,
                }
            };
            
            // 移除markdown树中的父级引用
            removeParents(placeholderScrapedSource.page.markdownTree);

            return {
                ...placeholderScrapedSource,
                context: result.snippet // 直接将snippet作为context内容
            };
        });

        yield makeSourcesUpdate(contextSources);

        // Step 4: 生成最终输出结构
        const webSearch: WebSearch = {
            prompt,
            searchQuery,
            results: validResults.map(r => ({ 
                title: r.title, 
                link: r.link,
                position: r.position // 保持原始搜索结果的位置信息
            })),
            contextSources: contextSources,
            createdAt,
            updatedAt,
        };
        yield makeFinalAnswerUpdate();
        return webSearch;

    } catch (searchError) {
        // 错误处理流程保持不变
        const message = searchError instanceof Error ? searchError.message : String(searchError);
        logger.error(message);
        yield makeErrorUpdate({ message: "An error occurred", args: [message] });

        const webSearch: WebSearch = {
            prompt,
            searchQuery: "",
            results: [],
            contextSources: [],
            createdAt,
            updatedAt,
        };
        yield makeFinalAnswerUpdate();
        return webSearch;
    }
}