import { RuntimeConfig as UserRuntimeConfig, PublicRuntimeConfig as UserPublicRuntimeConfig } from 'nuxt/schema'
  interface SharedRuntimeConfig {
   app: {
      buildId: string,

      baseURL: string,

      buildAssetsDir: string,

      cdnURL: string,
   },

   databaseUrl: string,

   betterAuthSecret: string,

   resendApiKey: string,

   anthropicApiKey: string,

   r2AccountId: string,

   r2AccessKeyId: string,

   r2SecretAccessKey: string,

   r2BucketName: string,

   adminEmail: string,

   enableAi: boolean,

   enableSbb: boolean,

   enableMagicLink: boolean,

   nitro: {
      envPrefix: string,
   },

   icon: {
      serverKnownCssClasses: Array<any>,
   },
  }
  interface SharedPublicRuntimeConfig {
   baseUrl: string,

   r2PublicUrl: string,
  }
declare module '@nuxt/schema' {
  interface RuntimeConfig extends UserRuntimeConfig {}
  interface PublicRuntimeConfig extends UserPublicRuntimeConfig {}
}
declare module 'nuxt/schema' {
  interface RuntimeConfig extends SharedRuntimeConfig {}
  interface PublicRuntimeConfig extends SharedPublicRuntimeConfig {}
}
declare module 'vue' {
        interface ComponentCustomProperties {
          $config: UserRuntimeConfig
        }
      }