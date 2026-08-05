// S95: 判断一条 run 错误是不是「CLI 授权类」——是的话错误卡上多给一个去
// /settings/models 授权状态区的出口。放 lib/（非 lib/server/）因为消费方是
// TurnCard / ChatNode 两个客户端组件。
//
// 判据取自实际见过的错误串（S93 的 OAuth 过期 + claude CLI 的常见认证输出），
// 宽一点没关系 —— 提示只是多一行链接，误报的代价是零；漏报的代价是用户对着
// 「OAuth session expired」不知道去哪修（S90-S93 就挂了 6 天）。
export function isAuthErrorMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /oauth|authenticat|unauthorized|401|api key|log ?in|credential/i.test(msg);
}
