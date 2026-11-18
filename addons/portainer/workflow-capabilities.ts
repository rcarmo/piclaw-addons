export type WorkflowCapabilitySpec = {
  /** Short display wording; excluded from the public capabilities payload. */
  callSummary?: string;
  category: string;
  summary: string;
  required_fields: string[];
  optional_fields?: string[];
  mutating?: boolean;
  destructive?: boolean;
  recommended_for?: string[];
  see_also?: string[];
  guidance?: string[];
  example_fields?: Record<string, unknown>;
};

export const PORTAINER_WORKFLOW_CAPABILITIES: Record<string, WorkflowCapabilitySpec> = {
  "endpoint.list": { category: "endpoint", callSummary: "list endpoints", summary: "List Portainer endpoints.", required_fields: [] },
  "endpoint.resolve": { category: "endpoint", callSummary: "resolve endpoint", summary: "Resolve an endpoint by ID or name.", required_fields: [], optional_fields: ["endpoint_id", "name"], recommended_for: ["finding an endpoint ID before inspect or mutate flows"] },
  "endpoint.inspect": { category: "endpoint", callSummary: "inspect endpoint", summary: "Inspect one endpoint.", required_fields: ["endpoint_id"] },
  "endpoint.ping": { category: "endpoint", callSummary: "ping endpoint", summary: "Ping a Docker endpoint.", required_fields: ["endpoint_id"] },
  "endpoint.docker_info": { category: "endpoint", callSummary: "read endpoint Docker info", summary: "Read Docker daemon info.", required_fields: ["endpoint_id"] },
  "endpoint.docker_version": { category: "endpoint", callSummary: "read endpoint Docker version", summary: "Read Docker version info.", required_fields: ["endpoint_id"] },
  "endpoint.system_df": { category: "endpoint", callSummary: "show endpoint disk usage", summary: "Read Docker disk-usage summary.", required_fields: ["endpoint_id"], recommended_for: ["checking host storage pressure before cleanup or upgrades"] },
  "stack.list": { category: "stack", callSummary: "list stacks", summary: "List stacks, optionally for one endpoint.", required_fields: [], optional_fields: ["endpoint_id"] },
  "stack.resolve": { category: "stack", callSummary: "resolve stack", summary: "Resolve a stack by ID or name.", required_fields: [], optional_fields: ["endpoint_id", "stack_id", "stack_name", "name"], recommended_for: ["finding a stack ID before file, update, or delete work"] },
  "stack.file": { category: "stack", callSummary: "read stack file", summary: "Read stack compose content.", required_fields: [], optional_fields: ["endpoint_id", "stack_id", "stack_name", "name"] },
  "stack.create_standalone": { category: "stack", callSummary: "create standalone stack", summary: "Create a standalone stack from compose content.", required_fields: ["endpoint_id", "stack_name", "stack_file_content"], mutating: true },
  "stack.update": { category: "stack", callSummary: "update stack", summary: "Update a stack with supplied compose content.", required_fields: ["endpoint_id", "stack_id", "stack_file_content"], mutating: true },
  "stack.pull_and_update": { category: "stack", callSummary: "pull and update stack", summary: "Resolve a stack, re-read its compose, and update with pull enabled.", required_fields: [], optional_fields: ["endpoint_id", "stack_id", "stack_name", "name"], mutating: true, recommended_for: ["refreshing stack-managed workloads", "safe stack image refreshes"], guidance: ["Prefer this over container.upgrade for stack-managed workloads."] },
  "stack.delete": { category: "stack", callSummary: "delete stack", summary: "Delete a stack.", required_fields: ["endpoint_id", "stack_id"], mutating: true, destructive: true },
  "container.list": { category: "container", callSummary: "list containers", summary: "List containers for an endpoint.", required_fields: ["endpoint_id"], optional_fields: ["unmanaged"] },
  "container.resolve": { category: "container", callSummary: "resolve container", summary: "Resolve a container by ID or name.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"], recommended_for: ["finding a precise container ID before inspect, delete, or upgrade flows"] },
  "container.inspect": { category: "container", callSummary: "inspect container", summary: "Inspect a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"] },
  "container.compose": { category: "container", callSummary: "read container Compose configuration", summary: "Export a container as practical compose YAML.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"] },
  "container.start": { category: "container", callSummary: "start container", summary: "Start a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"], mutating: true },
  "container.stop": { category: "container", callSummary: "stop container", summary: "Stop a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "timeout_sec"], mutating: true },
  "container.restart": { category: "container", callSummary: "restart container", summary: "Restart a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "timeout_sec"], mutating: true },
  "container.logs": { category: "container", callSummary: "read container logs", summary: "Read bounded container logs.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "tail", "timestamps"] },
  "container.mounts": { category: "container", callSummary: "mounts container", summary: "Inspect container mount attachments.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"] },
  "container.exec": { category: "container", callSummary: "run container command", summary: "Run a bounded non-interactive exec command.", required_fields: ["endpoint_id", "command"], optional_fields: ["container_id", "name", "command_args", "shell_family"], mutating: true, recommended_for: ["one-off diagnostics inside a container without opening a terminal"], guidance: ["Keep commands short and non-interactive; streaming attach is not supported here.", "Use shell_family=powershell for Windows containers and shell_family=posix for Linux/Unix containers."] },
  "container.upgrade": { category: "container", callSummary: "upgrade container", summary: "Upgrade one standalone container in place with rollback on start failure.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "image", "timeout_sec", "force"], mutating: true, recommended_for: ["refreshing standalone containers"], guidance: ["Prefer stack.pull_and_update for stack-managed workloads."] },
  "container.upgrade_many": { category: "container", callSummary: "upgrade containers", summary: "Upgrade multiple standalone containers using the single-container upgrade flow.", required_fields: ["endpoint_id", "names"], optional_fields: ["image", "timeout_sec", "force"], mutating: true, recommended_for: ["batch refreshing standalone containers"], guidance: ["Prefer stack.pull_and_update for stack-managed workloads."] },
  "container.delete": { category: "container", callSummary: "delete container", summary: "Delete a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "force"], mutating: true, destructive: true },
  "image.list": { category: "image", callSummary: "list images", summary: "List endpoint images.", required_fields: ["endpoint_id"] },
  "image.inspect": { category: "image", callSummary: "inspect image", summary: "Inspect one image.", required_fields: ["endpoint_id", "image"] },
  "image.pull": { category: "image", callSummary: "pull image", summary: "Pull an image.", required_fields: ["endpoint_id", "image"], mutating: true },
  "image.delete": { category: "image", callSummary: "delete image", summary: "Delete an image.", required_fields: ["endpoint_id", "image"], optional_fields: ["force"], mutating: true, destructive: true },
  "image.prune": { category: "image", callSummary: "prune image", summary: "Prune images.", required_fields: ["endpoint_id"], optional_fields: ["all_unused"], mutating: true, destructive: true },
  "image.update_check": { category: "image", callSummary: "check image updates", summary: "Compare local and remote image digests.", required_fields: ["endpoint_id", "image"], recommended_for: ["update planning", "drift checks before pull or upgrade"] },
  "network.list": { category: "network", callSummary: "list networks", summary: "List Docker networks.", required_fields: ["endpoint_id"] },
  "network.inspect": { category: "network", callSummary: "inspect network", summary: "Inspect a Docker network.", required_fields: ["endpoint_id"], optional_fields: ["network_id", "name"] },
  "network.create": { category: "network", callSummary: "create network", summary: "Create a Docker network.", required_fields: ["endpoint_id", "name"], optional_fields: ["driver", "internal", "attachable", "enable_ipv6", "labels", "options"], mutating: true },
  "network.delete": { category: "network", callSummary: "delete network", summary: "Delete a Docker network.", required_fields: ["endpoint_id"], optional_fields: ["network_id", "name"], mutating: true, destructive: true },
  "volume.list": { category: "volume", callSummary: "list volumes", summary: "List Docker volumes.", required_fields: ["endpoint_id"] },
  "volume.inspect": { category: "volume", callSummary: "inspect volume", summary: "Inspect a Docker volume.", required_fields: ["endpoint_id"], optional_fields: ["volume_name", "name"] },
  "volume.create": { category: "volume", callSummary: "create volume", summary: "Create a Docker volume.", required_fields: ["endpoint_id"], optional_fields: ["volume_name", "name", "driver", "labels", "options"], mutating: true },
  "volume.delete": { category: "volume", callSummary: "delete volume", summary: "Delete a Docker volume.", required_fields: ["endpoint_id"], optional_fields: ["volume_name", "name", "force"], mutating: true, destructive: true },
  "volume.prune": { category: "volume", callSummary: "prune volume", summary: "Prune unused Docker volumes.", required_fields: ["endpoint_id"], mutating: true, destructive: true },
};
