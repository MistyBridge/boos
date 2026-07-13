#!/usr/bin/env node
/**
 * This MCP server implements web content fetching and conversion functionality.
 * It provides tools for:
 * - Fetching raw text content from URLs
 * - Getting rendered HTML content with JavaScript execution
 * - Converting web content to Markdown format
 * - Extracting main content from web pages
 */
export declare function getRawTextString(request_url: string): Promise<any>;
export declare function getMarkdownStringFromHtmlByTD(request_url: string, mainOnly?: boolean): Promise<string>;
export declare function getMarkdownStringFromHtmlByNHM(request_url: string, mainOnly?: boolean): Promise<string>;
