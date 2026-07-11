import { render, screen } from '@solidjs/testing-library'
import { expect, it } from 'vitest'
import App from './App'

it('renders the DolbyX shell', () => {
  render(() => <App />)
  expect(screen.getByRole('heading', { name: 'DolbyX' })).toBeTruthy()
})
