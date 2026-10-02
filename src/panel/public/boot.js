/* 启动入口：必须在 shell.js 与所有 pages/*.js 之后加载，
   否则 PAGES 注册表还是空的（shell.js 里 boot() 只定义不调用）。 */
boot();
