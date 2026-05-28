# WeCom Callback Config

Use these Render environment variables before saving the WeCom callback settings.

```text
WECHAT_CORP_ID=your_corp_id
WECHAT_TOKEN=your_callback_token
WECHAT_ENCODING_AES_KEY=your_43_char_encoding_aes_key
```

Use this callback URL in WeCom:

```text
https://ai-avatar-wechat-mvp.onrender.com/wechat/callback
```

The server supports WeCom encrypted URL verification with:

```text
msg_signature
timestamp
nonce
echostr
```

It also supports encrypted XML POST callbacks with the `Encrypt` field.

