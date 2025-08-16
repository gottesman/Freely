declare module '../database/sql-wasm' {
  type InitSqlJs = (opts?: any) => Promise<any>
  const initSqlJs: InitSqlJs
  export default initSqlJs
}
