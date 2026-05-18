import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';

dotenv.config();

const { FEISHU_APP_ID, FEISHU_APP_SECRET } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error('Missing FEISHU_APP_ID or FEISHU_APP_SECRET in .env');
  process.exit(1);
}

const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const res = await client.request({
  method: 'GET',
  url: '/open-apis/bot/v3/info',
});

const bot = res?.data || res;
console.log(JSON.stringify({
  app_name: bot.app_name,
  open_id: bot.open_id,
  user_id: bot.user_id,
  union_id: bot.union_id,
}, null, 2));
