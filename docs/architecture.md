# Architecture

The browser loads `index.html`, CSS, JavaScript and the bundled incident records. `js/records.js` is the runtime dataset; `data/records.json` is its tooling/contribution copy. The curated trends map lives in `js/app.js`. The standalone HTML embeds the same application for sharing.

The container serves only public static assets through unprivileged nginx on port 8080. `/healthz` reports whether nginx is serving. The container has no AWS credentials, Kubernetes token, database or writable application storage. A temporary volume contains nginx process files.

The EKS deployment uses the `project-martian` namespace and release, two replicas, its own public ALB, the `project-martian` ECR repository, and a certificate covering `projectmartian.ai` and `www.projectmartian.ai`. Squarespace manages DNS. The separate cluster ingress release manages the shared AWS Load Balancer Controller. Application uninstall and upgrade do not own that controller.

Helm source and operational deployment instructions belong to `martian-helm-charts/charts/project-martian`, `martian-helm-charts/environments/project-martian` and that repository's `docs/project-martian.md`. This repository does not include Helm charts or import Martian Security application code. Shared EKS, nodes, VPC, and the cluster controller remain infrastructure dependencies; deleting the cluster itself affects both projects.

Ask performs local record matching on the public site. The existing Claude artifact integration is unavailable on ordinary hosting. Google Fonts and the optional existing Iconify logo import are third-party browser assets. No private Wiki, product API or customer records are read.
