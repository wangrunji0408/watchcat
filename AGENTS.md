# Repository Instructions

## Deployment

After every completed code, configuration, or documentation change, deploy the
updated service with:

```sh
pm2 restart watchcat
```

Then verify that the `watchcat` process is online with `pm2 status watchcat`.
