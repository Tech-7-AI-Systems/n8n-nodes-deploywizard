import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class DeployWizardApi implements ICredentialType {
  name = 'deployWizardApi';

  displayName = 'DeployWizard API';

  documentationUrl = 'https://github.com/Tech-7-AI-Systems/n8n-nodes-deploywizard#credential';

  icon: Icon = { light: 'file:deploywizard.svg', dark: 'file:deploywizard.dark.svg' };

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Your DeployWizard API key (starts with dw_live_)',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.deploywizard.io',
      required: true,
      description: 'Leave as is for DeployWizard cloud. If you run DeployWizard yourself, use its address, e.g. http://localhost:8787',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
  };

  test: ICredentialTestRequest = {
    request: { baseURL: '={{$credentials.baseUrl}}', url: '/v1/me' },
  };
}
