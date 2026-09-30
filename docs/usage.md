# Usage and publishing

Serve the source with `python3 -m http.server 8000` and open `http://localhost:8000`. There is no dependency installation or frontend build. Preserve the existing desktop design when editing.

Keep incident objects in `js/records.js` and `data/records.json` synchronized. Keep the standalone HTML synchronized when changing its embedded data, application code or styles. Public Ask answers are matched from these records; no hosted Claude service is configured.

## Container

Run commands from this repository after committing the intended website source:

```sh
SHA=$(git rev-parse HEAD)
REGISTRY=323022619236.dkr.ecr.us-west-1.amazonaws.com
docker buildx build --platform linux/amd64 --load \
  --label org.opencontainers.image.source=https://github.com/Project-Martian/Project-Martian \
  --label org.opencontainers.image.revision="$SHA" \
  -t "$REGISTRY/project-martian:$SHA" .
aws ecr get-login-password --profile martian --region us-west-1 \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker push "$REGISTRY/project-martian:$SHA"
```

The ECR repository enforces immutable tags. Pin the pushed image digest in the separate Helm repository's `environments/project-martian/production.yaml`; its `docs/project-martian.md` owns install, DNS and removal commands. A GitHub push does not deploy automatically.

The container serves on port 8080, runs as UID/GID 101, and writes process files only under `/tmp`. Root, JS, CSS, JSON and logo assets are included. Unknown paths return 404. Assets use revalidation because their filenames are not content hashes.
