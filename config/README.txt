Place plain-text configuration override files here.
Currently supported:
  spotify-token-endpoint.txt  -> first line is the full URL of the token endpoint returning { access_token, expires_in }
This is used as a fallback in packaged builds when process.env.SPOTIFY_TOKEN_ENDPOINT is not present.
