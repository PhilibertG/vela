import { mount } from 'svelte'
import '../app.css'
import Sidebar from './Sidebar.svelte'

mount(Sidebar, { target: document.getElementById('app')! })
