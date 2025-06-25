import * as cdk from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { InstanceClass, InstanceSize, InstanceType, Peer, Port, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerImage, Secret as ecsSecret, FargateService, FargateTaskDefinition, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, DatabaseSecret, PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class KeycloakOnAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const databaseName = 'keycloak';

    const vpc = new Vpc(this, 'app-vpc', { maxAzs: 2 });

    const adminSecret = new Secret(this, 'admin-secret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 16,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const dbSecret = new DatabaseSecret(this, 'keycloak-db-secret', {
      username: 'keycloakadmin',
    });

    const database = new DatabaseInstance(this, 'keycloak-db', {
      databaseName,
      vpc,
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_17
      }),
      instanceType: InstanceType.of(InstanceClass.BURSTABLE3, InstanceSize.SMALL),      
      credentials: Credentials.fromSecret(dbSecret),
      allocatedStorage: 100,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cluster = new Cluster(this, 'cluster', {vpc});

    const taskDefinition = new FargateTaskDefinition(this, 'keycloak-taskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    const keycloakContainer = taskDefinition.addContainer('keycloak', {
      containerName: 'keycloak',
      image: ContainerImage.fromRegistry('quay.io/keycloak/keycloak:latest'),
      command: ['start'],
      environment: {
        KC_DB: 'postgres',
        KC_DB_URL: `jdbc:postgresql://${database.dbInstanceEndpointAddress}:${database.dbInstanceEndpointPort}/${databaseName}`,
        KC_DB_USERNAME: Credentials.fromSecret(dbSecret).username,
        KC_BOOTSTRAP_ADMIN_USERNAME: Credentials.fromSecret(adminSecret).username,
        KC_HTTP_ENABLED: 'true',
        KC_HOSTNAME_STRICT: 'false',
        KC_PROXY_HEADERS: 'xforwarded'
      },
      secrets: {
        KC_DB_PASSWORD: ecsSecret.fromSecretsManager(dbSecret, 'password'),
        KC_BOOTSTRAP_ADMIN_PASSWORD: ecsSecret.fromSecretsManager(adminSecret, 'password')
      },
      portMappings: [{
        containerPort: 8080,
        hostPort: 8080
      }],
      logging: LogDrivers.awsLogs({streamPrefix: 'keycloak-service', logRetention: RetentionDays.ONE_DAY})
    });

    const ecsService = new FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1
    });

    database.connections.allowDefaultPortFrom(ecsService);

    const cert = Certificate.fromCertificateArn(this, 'albcert', StringParameter.valueForStringParameter(this, 'cert-arn'));

    const alb = new ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true
    });

    const listener = alb.addListener('keycloak-listener', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [cert],
      sslPolicy: SslPolicy.FORWARD_SECRECY_TLS12
    });

    listener.addTargets('keycloak-target', {
      port: 8080,
      targets: [ecsService],
      protocol: ApplicationProtocol.HTTP,
      healthCheck: {
        path: '/admin/master/console/',
        healthyThresholdCount: 2,
      }
    });

    new cdk.CfnOutput(this, 'alb-url', {
      value: `https://${alb.loadBalancerDnsName}`,
      exportName: 'loadBalancerDnsName'
    });
    
  }
}
