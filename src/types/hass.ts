// 最小 HA 前端类型定义。
//
// 刻意**不引** `custom-card-helpers`: 我们只需要很少几个字段, 引一个类型包会把
// bundle 拉大且带来版本耦合。这里按卡片实际用到的字段声明, 够用即可。
export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_updated?: string;
}

export interface HassUser {
  is_admin?: boolean;
  name?: string;
}

export interface HassThemes {
  darkMode?: boolean;
}

/** 卡片拿到的 hass 对象(只声明本项目用到的部分)。 */
export interface HomeAssistant {
  states: Record<string, HassEntity>;
  callWS?: <T = any>(msg: Record<string, any>) => Promise<T>;
  callService?: (domain: string, service: string, data?: Record<string, any>) => Promise<unknown>;
  themes?: HassThemes;
  user?: HassUser;
}

/** Lovelace 卡片配置(YAML)。字段随卡片而异, 用宽松索引签名。 */
export interface LovelaceCardConfig {
  type: string;
  [key: string]: any;
}

/** 卡片选择器里展示用的元信息。 */
export interface CustomCardInfo {
  type: string;
  name: string;
  description?: string;
  preview?: boolean;
  documentationURL?: string;
}

declare global {
  interface Window {
    customCards?: CustomCardInfo[];
  }
}
